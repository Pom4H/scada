import { registerComponent } from '../../core';
registerComponent('filter', {
  version: '1.0.0', label: 'Фильтр', prefix: 'FLT', width: 130, height: 100,
  fields: {
    x: { scope: 'layout', label: 'X', default: 100, min: -3000, max: 6000 }, y: { scope: 'layout', label: 'Y', default: 100, min: -3000, max: 6000 },
    resistance: { label: 'Сопротивление', default: .1, min: 0, max: 1, step: .01, unit: 'доля' },
    quality: { label: 'Качество', default: 'good', choices: ['good', 'stale', 'bad'] },
    alarm: { label: 'Состояние', default: 'none', choices: ['none', 'warning', 'trip'] },
  },
  ports: { inlet: { x: 0, y: 50, direction: 'left', role: 'in' }, outlet: { x: 130, y: 50, direction: 'right', role: 'out' } },
  signals: { flow: { label: 'Расход', type: 'number', unit: 'm3/h' }, differentialPressure: { label: 'Перепад давления', type: 'number', unit: 'bar' } },
  commands: { clean: { label: 'Очистить фильтр' } },
});
