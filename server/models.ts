import '../src/components/installed';
import { filterBehavior } from '../src/components/filter/behavior';
import { BehaviorRegistry, clamp, number, parameter, type BehaviorDefinition } from './behavior';

export const pumpBehavior: BehaviorDefinition = {
  kind: 'pump', version: '1.0.0',
  assumptions: [
    'Synthetic centrifugal-pump behavior; no hydraulic, thermal or structural solver.',
    'Drive RPM and impeller transfer efficiency are independent states. Wear reduces flow and head while increasing measured vibration and temperature.',
    'Degradation starts after five model seconds, grows at the authored degradationRate while rotating, and breaks the impeller at wear 0.85.',
    'Service stops the drive for maintenanceSeconds, restores the same instance and resumes its previous command. Replacement installs a new instance.',
    'Noise is seeded and bounded; the temperature approaches a synthetic target with a 5-second time constant.',
  ],
  initialize: ({ node }) => ({ rpm: 0, targetRpm: parameter(node, 'rpm', 1500), enabled: parameter(node, 'rpm', 1500) !== 0, wear: 0, integrity: 1, temperature: parameter(node, 'temperature', 48), vibration: parameter(node, 'vibration', 1.8), startAt: parameter(node, 'startDelay', 1) * 1000, serviceUntil: 0, servicedAt: 0, noise: 0, broken: false }),
  advance(state, c) {
    if (number(state, 'serviceUntil') > 0 && c.simTimeMs >= number(state, 'serviceUntil')) {
      state.serviceUntil = 0; state.wear = 0; state.integrity = 1; state.broken = false; state.servicedAt = c.simTimeMs;
      state.startAt = c.simTimeMs + parameter(c.node, 'startDelay', 1) * 1000;
      c.emit('maintenance.completed', 'Обслуживание завершено');
      c.record('impeller.restored', { integrity: 1 });
    }
    const servicing = number(state, 'serviceUntil') > c.simTimeMs;
    const active = !!state.enabled && !servicing && c.simTimeMs >= number(state, 'startAt') && c.node.props.alarm !== 'trip';
    const target = active ? number(state, 'targetRpm') : 0;
    const acceleration = 1500 * c.dtMs / 1000;
    state.rpm = number(state, 'rpm') + clamp(target - number(state, 'rpm'), -acceleration, acceleration);
    if (c.scenario === 'degradation' && !servicing && c.simTimeMs >= Math.max(5000, number(state, 'servicedAt') + 5000) && Math.abs(number(state, 'rpm')) > 1) {
      state.wear = clamp(number(state, 'wear') + parameter(c.node, 'degradationRate', .008) * c.dtMs / 1000, 0, 1);
      if (number(state, 'wear') >= .85 && !state.broken) { state.broken = true; c.record('impeller.broken', { wear: number(state, 'wear') }); }
    }
    state.integrity = state.broken ? .04 : 1 - .85 * number(state, 'wear');
    state.noise = (c.random() - .5) * .08;
    const spinning = Math.abs(number(state, 'rpm')) / 1500;
    const thermalTarget = parameter(c.node, 'temperature', 48) + 37 * number(state, 'wear') * spinning + (state.broken ? 8 : 0);
    state.temperature = number(state, 'temperature') + (thermalTarget - number(state, 'temperature')) * (1 - Math.exp(-c.dtMs / 5000));
    state.vibration = spinning < .001 ? 0 : Math.max(0, parameter(c.node, 'vibration', 1.8) * spinning + 8 * number(state, 'wear') + (state.broken ? 3 : 0) + number(state, 'noise'));
  },
  output(state, c) {
    const servicing = number(state, 'serviceUntil') > c.simTimeMs;
    const alarm = c.node.props.alarm === 'trip' || number(state, 'vibration') >= 10 ? 'trip' : c.node.props.alarm === 'warning' || number(state, 'vibration') >= 4.5 ? 'warning' : 'none';
    const rpm = number(state, 'rpm');
    return {
      mode: servicing ? 'maintenance' : state.enabled && c.simTimeMs < number(state, 'startAt') ? 'starting' : Math.abs(rpm) > .1 ? 'running' : 'stopped', alarm,
      signals: { rpm, flow: c.transport.flow, temperature: number(state, 'temperature'), vibration: number(state, 'vibration') },
      process: { boundary: 'inline', driverFlow: parameter(c.node, 'nominalFlow', 12) * rpm / 1500 * number(state, 'integrity'), headBar: 5.8 * (rpm / 1500) ** 2 * number(state, 'integrity') },
    };
  },
  command(state, cmd, c) {
    switch (cmd.command) {
      case 'start': state.enabled = true; state.startAt = c.simTimeMs + parameter(c.node, 'startDelay', 1) * 1000; break;
      case 'stop': state.enabled = false; break;
      case 'setSpeed': state.targetRpm = cmd.value as number; break;
      case 'service':
        if (number(state, 'serviceUntil') > c.simTimeMs) throw new Error('Equipment is already under maintenance');
        state.serviceUntil = c.simTimeMs + parameter(c.node, 'maintenanceSeconds', 3) * 1000;
        c.record('maintenance.started', { wear: number(state, 'wear'), integrity: number(state, 'integrity') });
        break;
      case 'replace': {
        const replacement = pumpBehavior.initialize(c);
        replacement.targetRpm = state.targetRpm; replacement.enabled = state.enabled; replacement.servicedAt = c.simTimeMs;
        replacement.startAt = c.simTimeMs + parameter(c.node, 'startDelay', 1) * 1000;
        Object.assign(state, replacement); c.record('instance.replaced', { reason: 'operator-command' }); return { replace: true };
      }
    }
  },
};
const tankBehavior: BehaviorDefinition = {
  kind: 'tank', version: '1.0.0', assumptions: ['Synthetic cylindrical reservoir with fixed 10 m3 capacity; level changes from installation flow, clamped to 0..100%. No automatic refill.'],
  initialize: c => ({ level: parameter(c.node, 'level', 64) }),
  advance(state, c) { if (c.transport.flow !== null) state.level = clamp(number(state, 'level') - c.transport.flow / 3600 * c.dtMs / 1000 / 10 * 100, 0, 100); },
  output: state => ({ mode: number(state, 'level') > 0 ? 'available' : 'empty', alarm: number(state, 'level') <= 5 ? 'warning' : 'none', signals: { level: number(state, 'level') }, process: { boundary: 'source', available: number(state, 'level') > 0, temperatureC: 20 } }),
};
const valveBehavior: BehaviorDefinition = {
  kind: 'valve', version: '1.0.0', assumptions: ['Actuator moves at 40 percentage points per second. The synthetic series rule multiplies flow by opening/100; this is not a valve characteristic curve.'],
  initialize: c => ({ opening: parameter(c.node, 'opening', 76), targetOpening: parameter(c.node, 'opening', 76) }),
  advance(state, c) { state.opening = number(state, 'opening') + clamp(number(state, 'targetOpening') - number(state, 'opening'), -40 * c.dtMs / 1000, 40 * c.dtMs / 1000); },
  output: (state, c) => ({ mode: Math.abs(number(state, 'opening') - number(state, 'targetOpening')) > .01 ? 'moving' : 'ready', alarm: c.node.props.alarm === 'trip' ? 'trip' : 'none', signals: { opening: number(state, 'opening'), flow: c.transport.flow }, process: { boundary: 'inline', conductance: c.node.props.alarm === 'trip' ? 0 : number(state, 'opening') / 100 } }),
  command(state, cmd) { if (cmd.command === 'setOpening') state.targetOpening = cmd.value as number; },
};
const passive = (kind: string, boundary: 'inline' | 'sink'): BehaviorDefinition => ({
  kind, version: '1.0.0', assumptions: ['Passive synthetic transport observer; no additional pressure-loss or energy model.'],
  initialize: () => ({}), advance() {},
  output: (_state, c) => ({ mode: 'ready', alarm: 'none', signals: { flow: c.transport.flow }, process: { boundary } }),
});
const exchangerBehavior: BehaviorDefinition = {
  ...passive('exchanger', 'inline'), assumptions: ['Synthetic ideal heater with fixed authored outlet temperature; no thermal mass, secondary loop or energy balance.'],
  output: (_state, c) => ({ mode: 'ready', alarm: 'none', signals: { flow: c.transport.flow, temperature: parameter(c.node, 'temperature', 72) }, process: { boundary: 'inline', temperatureC: parameter(c.node, 'temperature', 72) } }),
};
const sensor = (kind: 'pressure' | 'temperature', field: 'pressure' | 'temperature'): BehaviorDefinition => ({
  kind, version: '1.0.0', assumptions: ['Synthetic tapped observation of the installation transport channel; a disconnected or unsupported line is unknown.'],
  initialize: () => ({}), advance() {}, output: (_state, c) => ({ mode: c.transport[field] === null ? 'unknown' : 'measuring', alarm: 'none', signals: { value: c.transport[field] } }),
});
export function installedBehaviors(): BehaviorRegistry {
  return new BehaviorRegistry().register(tankBehavior).register(pumpBehavior).register(valveBehavior).register(passive('flowmeter', 'inline')).register(exchangerBehavior).register(passive('outlet', 'sink')).register(sensor('pressure', 'pressure')).register(sensor('temperature', 'temperature')).register(filterBehavior);
}
