import { tank, pump, outlet, connect } from '@scada/core';

const source = tank('T-101', { x: 40, y: 100, level: 64 });
const motor = pump('P-101', {
  x: 325, y: 188, rpm: 1500,
  nominalFlow: 12, degradationRate: 0.008,
  startDelay: 1, maintenanceSeconds: 3,
});
const sink = outlet('OUT', { x: 700, y: 150 });
connect(source.outlet, motor.inlet);
connect(motor.outlet, sink.inlet);
