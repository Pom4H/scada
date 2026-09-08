// Isolate animation cadence from video recording. Uses the same two-run fixture
// and browser settings as runtime-qa-capture.mjs, with no recorder or screenshots.
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const output=resolve(process.env.SCADA_QA_CAPTURE_DIR||'.runtime-evidence/final');
await mkdir(output,{recursive:true});
await build({stdin:{contents:'export {startServer} from "./server/index"; export {booster} from "./src/examples";',resolveDir:process.cwd()},outfile:'.test/runtime-qa-animation.mjs',bundle:true,platform:'node',format:'esm',packages:'external',target:'es2022'});
const {startServer,booster}=await import(pathToFileURL(resolve('.test/runtime-qa-animation.mjs')).href);
const temporary=await mkdtemp(join(tmpdir(),'scada-animation-'));
const application=await startServer({port:0,host:'127.0.0.1',dataPath:join(temporary,'runs.sqlite'),staticDir:resolve('dist'),autoTick:true});
const text=run=>`import {runtime} from '@scada/core';\nruntime({server:'${application.url}',project:'animation-qa'${run?`,run:'${run}'`:''}});\n${booster}`;
const reference=application.engine.create({projectId:'animation-qa',label:'Reference',source:text(),scenario:'normal',seed:42});
const active=application.engine.create({projectId:'animation-qa',label:'Observed',source:text(),scenario:'normal',seed:42});
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'no-preference'}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const measure=async()=>page.evaluate(()=>new Promise(resolve=>{
  let warmup=20,last;const values=[];
  const tick=now=>{if(warmup>0){warmup--;last=now;requestAnimationFrame(tick);return;}values.push(now-last);last=now;if(values.length<90){requestAnimationFrame(tick);return;}const sorted=[...values].sort((a,b)=>a-b);resolve({count:values.length,medianMs:sorted[45],p95Ms:sorted[85],maxMs:sorted.at(-1),samples:values});};requestAnimationFrame(tick);
}));
try{
  await page.goto(application.url+'/scada/#code='+Buffer.from(text(active.run.id)).toString('base64url'));
  await page.waitForFunction(()=>!!window.__scada?.runtime);
  await page.locator('#server-token').fill(application.tokens.view);await page.locator('#connect-server').click();
  await expect.poll(()=>page.evaluate(()=>window.__scada.runtime.frame?.equipment['P-101']?.signals.rpm.value??0)).toBe(1500);
  const svg=await measure();
  await page.locator('#view-3d').click();await expect(page.locator('#scene3d canvas')).toBeVisible({timeout:20000});
  const three=await measure();
  const state=await page.evaluate(()=>{
    const canvas=document.querySelector('#scene3d canvas'),gl=canvas.getContext('webgl2'),debug=gl.getExtension('WEBGL_debug_renderer_info');
    return {frame:window.__scada.runtime.frame,three:window.__scada.view3d,graphics:{version:gl.getParameter(gl.VERSION),vendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):null,renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null}};
  });
  const report={measuredAt:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),node:process.version,browser:browser.version(),cpu:os.cpus()[0]?.model,logicalCpus:os.availableParallelism(),platform:`${os.platform()} ${os.arch()}`,viewport:{width:1440,height:900},liveRuns:2,serverStepMs:100,equipment:8,links:5,recordVideo:false,methodology:'Native RAF cadence, 20 warm-up and 90 measured intervals per view. Two live synthetic runs, one observed browser. Software SwiftShader WebGL; this measures this shared runtime, not hardware device FPS.',svg,three,state,errors};
  await writeFile(join(output,'animation-without-recording.json'),JSON.stringify(report,null,2)+'\n');
  if(errors.length)throw new Error(errors.join('; '));
  console.log(JSON.stringify({svgP95Ms:svg.p95Ms,threeP95Ms:three.p95Ms,drawCalls:state.three.calls,triangles:state.three.triangles,graphics:state.graphics,errors}));
}finally{await browser.close();await application.close();await rm(temporary,{recursive:true,force:true});}
