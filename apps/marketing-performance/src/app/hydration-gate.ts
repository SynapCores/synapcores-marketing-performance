/**
 * Hydration gate: start hydrating only once the page's JS chunks have loaded.
 *
 * Why: the page HTML names its client-component chunks as <script async>.
 * When the webpack runtime (cached) runs before some of those chunks have
 * arrived, the RSC client hands React a *lazy element* for that client
 * component (e.g. the sidebar inside DashboardLayout's root <div>). React
 * suspends while reconciling that host <div>, and on replay React 19.2 (the
 * canary bundled with Next 15.5) re-enters the <div> with its hydration cursor
 * already on the div's first child, which throws minified error #418 and
 * re-renders the whole page on the client. It is random because it depends on
 * script arrival order (more likely behind Apache's gzip, which delivers the
 * whole document in one burst). Holding webpack's chunk queue until `load`
 * means every chunk is installed before hydration starts, so nothing
 * suspends. If `load` is slow (a hanging image), hydration is released
 * HYDRATION_GATE_MAX_MS after DOMContentLoaded and React's own recovery
 * applies, as before.
 *
 * Mechanics: Next's webpack runtime processes chunks pushed before it ran with
 * `self.webpackChunk_N_E.forEach(...)` and later ones through the `push` it
 * installs. Both are queued until the gate opens. Nothing is rendered, so
 * there is no visible change; the server HTML stays on screen meanwhile.
 */
export const WEBPACK_CHUNK_GLOBAL = 'webpackChunk_N_E';
export const HYDRATION_GATE_MAX_MS = 3000;

export const HYDRATION_GATE_SCRIPT = `(function(){try{
if(document.readyState==="complete")return;
var q=self.${WEBPACK_CHUNK_GLOBAL}=self.${WEBPACK_CHUNK_GLOBAL}||[];
if(q.__gate)return;q.__gate=1;
var open=false,pending=[];
function release(){if(open)return;open=true;var p=pending;pending=[];for(var i=0;i<p.length;i++)p[i]();}
addEventListener("load",release,{once:true});
document.addEventListener("DOMContentLoaded",function(){setTimeout(release,${HYDRATION_GATE_MAX_MS})},{once:true});
var forEach=q.forEach;
q.forEach=function(cb,t){var a=this;if(open)return forEach.call(a,cb,t);pending.push(function(){forEach.call(a,cb,t)});};
var push=q.push;
Object.defineProperty(q,"push",{configurable:true,get:function(){return push},set:function(fn){push=function(){var a=this,args=arguments;if(open)return fn.apply(a,args);pending.push(function(){fn.apply(a,args)});return a.length;};}});
}catch(e){}})();`;
