import { defineComponent } from '@pom4h/scada/sdk';
import { connect, tank, outlet } from '@pom4h/scada/core';

const regulator = defineComponent('consumerRegulator', {
  version: '1.0.0', label: 'Regulator', width: 100, height: 60,
  fields: {
    x: {label:'X',default:100,scope:'layout'}, y: {label:'Y',default:100,scope:'layout'},
    gain: {label:'Gain',default:1,min:0,max:10}, enabled: {label:'Enabled',default:true},
    mode: {label:'Mode',default:'auto',choices:['auto','manual']},
  },
  ports: { feed: {x:0,y:30,direction:'left',role:'in'}, drain: {x:100,y:30,direction:'right',role:'out'} },
  signals: { value: {label:'Value',type:'number',unit:'bar'} },
  commands: { setGain: {label:'Set gain',valueType:'number'}, reset: {label:'Reset'} },
});
const source = tank('T', {x:0,y:0}), target = outlet('OUT', {x:300,y:0});
const node = regulator('R', {x:150,y:0,gain:2,enabled:true,mode:'auto'});
const incoming = connect(source.outlet,node.feed), outgoing = connect(node.drain,target.inlet);
const command = regulator.command(node.id,'id-1','setGain',3);
if (incoming.to.port !== 'feed' || outgoing.from.port !== 'drain' || command.value !== 3) throw new Error('SDK public contract failed');
// These examples are compiled but never executed. An accidentally weakened API fails the smoke test.
if (false) {
  // @ts-expect-error Unknown property
  regulator('bad', {gian:2});
  // @ts-expect-error Wrong field type
  regulator('bad', {gain:'high'});
  // @ts-expect-error Invalid enum
  regulator('bad', {mode:'turbo'});
  // @ts-expect-error No such port
  connect(node.typo,target.inlet);
  // @ts-expect-error Input cannot be used as an output
  connect(node.feed,target.inlet);
  // @ts-expect-error Command expects a number
  regulator.command('R','id-2','setGain','high');
  // @ts-expect-error A parameterless command takes no value
  regulator.command('R','id-3','reset',1);
}
console.log('External SDK consumer passed');
