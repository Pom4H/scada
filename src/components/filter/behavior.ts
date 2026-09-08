import { clamp, number, parameter, type BehaviorDefinition } from '../../../server/behavior';

/** Independent package: only registration in server/models.ts is required. */
export const filterBehavior: BehaviorDefinition = {
  kind: 'filter', version: '1.0.0',
  assumptions: ['Synthetic passive filter. Conductance is 1-resistance; differential pressure is 2*resistance*abs(flow)/12 bar. No particulate or fluid solver. Cleaning resets resistance to zero.'],
  initialize: c => ({ resistance: parameter(c.node, 'resistance', .1) }),
  advance() {},
  output(state, c) {
    const resistance = clamp(number(state, 'resistance'), 0, 1);
    return { mode: 'filtering', alarm: resistance > .8 ? 'warning' : 'none', signals: { flow: c.transport.flow, differentialPressure: c.transport.flow === null ? null : 2 * resistance * Math.abs(c.transport.flow) / 12 }, process: { boundary: 'inline', conductance: 1 - resistance } };
  },
  command(state, cmd, c) { if (cmd.command === 'clean') { state.resistance = 0; c.emit('maintenance.completed', 'Фильтр очищен'); } },
};
