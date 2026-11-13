/*
 * Signal Orb, adapted for Jarvis.
 * Source: https://github.com/aqualang89/shipnotes-components (components/signal-orb),
 * commit 3e950856c8e27e7835e6bc5af1b29b37a7debaee.
 *
 * MIT License. Copyright (c) 2026 Ship Notes.
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following
 * conditions: The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 * WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 * NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
 * OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 * OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Changes for Jarvis:
 * - States idle, speaking and attention (needs your OK) join listening, thinking,
 *   searching and done. The four sphere states share one shape with their own size,
 *   ripple and brightness; idle is small, dim and breathing.
 * - Colours tuned for a dark page, with amber kept for "needs your OK" as in the app. On a light
 *   page (prefers-color-scheme) the same hues are drawn as deep inks, with dark sparks instead of white.
 * - Styles through a constructed stylesheet, so the page's CSP needs no inline styles.
 * - `level` is smoothed per frame, so a level set ten times a second still moves softly.
 * - Idle draws at about 20 fps, and an orb that's off screen doesn't draw at all.
 */
(() => {
  if (customElements.get('signal-orb')) return;
  const names = ['idle', 'listening', 'speaking', 'attention', 'thinking', 'searching', 'done'];
  const SPHERES = 4; // the first four states are the sphere shape
  const colors = [[168,176,188],[72,214,204],[176,228,255],[240,176,74],[160,146,255],[96,190,250],[110,226,160]];
  const inks = [[74,80,90],[0,128,121],[28,104,160],[178,104,0],[92,70,210],[16,110,186],[24,138,78]];
  const darkPage = matchMedia('(prefers-color-scheme: dark)');
  const dims = [.62,1,1,1,1,1,1];
  const tau = Math.PI * 2;
  const cache = new Map();
  const seedsFor = count => {
    // a dense Fibonacci sphere shows moire stripes, so past 1000 points each one gets a small fixed nudge
    const jitter = count > 1000 ? (1 - 1000 / count) * 1.6 / Math.sqrt(count) : 0;
    const rnd = n => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
    if (!cache.has(count)) cache.set(count, Array.from({length:count}, (_,i) => {
      const y0 = 1 - 2 * (i + .5) / count, a = i * 2.399963229728653 + (rnd(i) - .5) * jitter * 6;
      const y = Math.max(-1, Math.min(1, y0 + (rnd(i + .37) - .5) * jitter));
      return {x:Math.cos(a)*Math.sqrt(1-y*y), y, z:Math.sin(a)*Math.sqrt(1-y*y), a, u:i/count, sa:Math.sin(a), ca:Math.cos(a)};
    }));
    return cache.get(count);
  };
  // per band: cos/sin of the tilt, cos/sin of the rotation
  const bandTilt = [[.32,0],[-.72,1.02],[1.08,-.82]].map(([tilt,rot]) => [Math.cos(tilt+1),Math.sin(tilt+1),Math.cos(rot),Math.sin(rot)]);
  const autoCount = () => matchMedia('(pointer: coarse)').matches ? 6000 : 12000;
  let sheet = null;
  const styles = () => {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(':host{display:block;width:100%;aspect-ratio:1;contain:layout paint;position:relative}canvas{position:absolute;inset:0;width:100%;height:100%;display:block}');
    }
    return sheet;
  };

  // One dot = solid core (to 20% of its radius), faint .065 halo, white spark in front. Same shape in both renderers.
  const VS = `attribute vec2 p;attribute vec3 d;uniform vec2 res;varying float a;varying float s;
    void main(){float size=max(d.x,2.0);float k=min(1.0,d.x*d.x/(size*size));a=d.y*k;s=d.z*k;
    gl_Position=vec4(p/res*2.0-1.0,0.0,1.0)*vec4(1,-1,1,1);gl_PointSize=size;}`;
  const FS = `precision mediump float;uniform vec3 col;uniform vec3 spk;varying float a;varying float s;
    void main(){float r=length(gl_PointCoord-.5)*2.0;if(r>1.0)discard;
    float dot=mix(1.0,.065,smoothstep(.17,.23,r))*(1.0-smoothstep(.9,1.0,r));
    float sp=mix(1.0,.065,smoothstep(.08,.12,r))*(1.0-smoothstep(.17,.2,r));
    gl_FragColor=vec4(col*dot*a+spk*(sp*s),min(1.0,dot*a+sp*s));}`;
  const setupGL = canvas => {
    const gl = canvas.getContext('webgl', {premultipliedAlpha:true, preserveDrawingBuffer:true, antialias:false});
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const lp = gl.getAttribLocation(prog, 'p'), ld = gl.getAttribLocation(prog, 'd');
    gl.enableVertexAttribArray(lp); gl.enableVertexAttribArray(ld);
    gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 20, 0); gl.vertexAttribPointer(ld, 3, gl.FLOAT, false, 20, 8);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    return {gl, res:gl.getUniformLocation(prog, 'res'), col:gl.getUniformLocation(prog, 'col'), spk:gl.getUniformLocation(prog, 'spk')};
  };
  const sprite = (rgb, core) => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), grad = g.createRadialGradient(32,32,0,32,32,32);
    grad.addColorStop(0, `rgba(${rgb},1)`); grad.addColorStop(core, `rgba(${rgb},1)`);
    grad.addColorStop(core + .03, `rgba(${rgb},.065)`); grad.addColorStop(.94, `rgba(${rgb},.065)`); grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad; g.fillRect(0,0,64,64);
    return c;
  };

  class SignalOrb extends HTMLElement {
    static get observedAttributes() { return ['state','level','particles']; }
    connectedCallback() {
      if (!this.shadowRoot) {
        const root = this.attachShadow({mode:'open'});
        root.adoptedStyleSheets = [styles()];
        const halo = document.createElement('canvas'), dots = document.createElement('canvas');
        halo.setAttribute('aria-hidden','true'); dots.setAttribute('aria-hidden','true');
        root.append(halo, dots);
        this.canvas=halo; this.ctx=halo.getContext('2d'); this.dots=dots;
        this.gl=setupGL(dots); if(!this.gl) this.dctx=dots.getContext('2d');
        this.setAttribute('role','img');
      }
      this.media=matchMedia('(prefers-reduced-motion: reduce)');
      this.weights=names.map(n=>n===this.state?1:0); this.time=0; this.last=0; this.slow=0; this.lv=this.level; this.visible=true;
      this.resize=()=>{const size=Math.max(1,Math.round(this.getBoundingClientRect().width*Math.min(devicePixelRatio||1,2)));this.canvas.width=this.canvas.height=this.dots.width=this.dots.height=size;this.paint(this.media.matches?0:this.time,this.weights);};
      this.observer=new ResizeObserver(this.resize);this.observer.observe(this);this.resize();
      this.seen=new IntersectionObserver(([e])=>{this.visible=e.isIntersecting;});this.seen.observe(this);
      this.onMotion=()=>{cancelAnimationFrame(this.frame);this.last=0;this.paint(0,names.map(n=>n===this.state?1:0));if(!this.media.matches&&!this.hasAttribute('recording'))this.frame=requestAnimationFrame(this.tick);};
      this.media.addEventListener('change',this.onMotion);
      this.onTheme=()=>this.paint(this.media.matches?0:this.time,this.weights);
      darkPage.addEventListener('change',this.onTheme);
      this.setAttribute('aria-label',`Assistant ${this.state}`);
      if(!this.hasAttribute('recording')&&!this.media.matches)this.frame=requestAnimationFrame(this.tick);
    }
    disconnectedCallback(){cancelAnimationFrame(this.frame);this.observer?.disconnect();this.seen?.disconnect();this.media?.removeEventListener('change',this.onMotion);darkPage.removeEventListener('change',this.onTheme);}
    get state(){const value=this.getAttribute('state');return names.includes(value)?value:'idle';}
    get level(){const n=Number(this.getAttribute('level')??'.3');return Number.isFinite(n)?Math.max(0,Math.min(1,n)):.3;}
    get particles(){const n=parseInt(this.getAttribute('particles'),10);return Number.isFinite(n)?Math.max(200,Math.min(20000,n)):(this.auto??=this.gl?autoCount():1000);}
    attributeChangedCallback(){if(!this.ctx)return;this.setAttribute('aria-label',`Assistant ${this.state}`);if(this.media?.matches){this.weights=names.map(n=>n===this.state?1:0);this.lv=this.level;this.paint(0,this.weights);}}
    tick=(now)=>{
      this.frame=requestAnimationFrame(this.tick);
      if(!this.visible){this.last=0;return;}
      // A settled idle orb only needs about 20 frames a second.
      const settled=this.state==='idle'&&this.weights[0]>.995;
      if(settled&&this.last&&now-this.last<48)return;
      const dt=this.last?Math.min((now-this.last)/1000,.05):0;this.last=now;this.time+=dt;
      // auto mode only: 30 slow frames in a row (under ~40 fps) cut the count by 40%
      if(!this.hasAttribute('particles')&&dt&&!settled){this.slow=dt>.025?this.slow+1:0;if(this.slow>30&&this.auto>800){this.auto=Math.max(800,Math.round(this.auto*.6));this.slow=0;}}
      const k=1-Math.exp(-dt*7);
      this.weights=this.weights.map((w,i)=>w+((names[i]===this.state?1:0)-w)*k);
      this.lv+=(this.level-this.lv)*(1-Math.exp(-dt*12));
      this.paint(this.time,this.weights);
    };
    renderAt(time,weights){this.paint(time,weights);}
    paint(t,w){
      const ctx=this.ctx,size=this.canvas.width;if(!size)return;
      const unit=size/720;ctx.setTransform(unit,0,0,unit,0,0);ctx.clearRect(0,0,720,720);
      const pal=darkPage.matches?colors:inks;
      const rgb=[0,1,2].map(c=>Math.round(pal.reduce((s,col,i)=>s+col[c]*w[i],0))),color=rgb.join(',');
      const spark=darkPage.matches?[255,255,255]:rgb.map(c=>Math.round(c*.45));
      const dim=dims.reduce((s,d,i)=>s+d*w[i],0);
      const halo=ctx.createRadialGradient(360,360,10,360,360,305);
      halo.addColorStop(0,`rgba(${color},${.075*dim})`);halo.addColorStop(.57,`rgba(${color},${.035*dim})`);halo.addColorStop(1,`rgba(${color},0)`);
      ctx.fillStyle=halo;ctx.fillRect(0,0,720,720);
      const count=this.particles,seeds=seedsFor(count),ring=Math.round(count*.65);
      // more particles = finer and dimmer each, so the sphere gets denser instead of blown out
      const fine=Math.max(.5,Math.pow(1000/count,.55)),light=Math.min(1,Math.pow(1000/(count*fine*fine),.35))*dim*(darkPage.matches?1:1.5); // ink on a light page needs more cover than light on dark
      if(!this.buf||this.buf.length<count*5)this.buf=new Float32Array(count*5);
      const lv=this.lv??this.level;
      const buf=this.buf,spin=t*.23,cs=Math.cos(spin),sn=Math.sin(spin);
      // The sphere states, blended: idle breathes small, listening and speaking ripple with the level, attention pulses.
      const [wi,wl,wp,wa]=w,[wt,ws,wd]=w.slice(SPHERES),sw=wi+wl+wp+wa;
      const R=wi*(120+7*Math.sin(t*.9))+wl*192+wp*184+wa*(170+10*Math.sin(t*2.2));
      const wave=wi*2.5+wl*(8+lv*22)+wp*(6+lv*26)+wa*5,ripple=wi*2+(wl+wp)*5+wa*3;
      for(let i=0;i<count;i++){
        const p=seeds[i];let vx=0,vy=0,vz=0;
        if(sw>.001){
          const x=p.x*cs+p.z*sn,z=p.z*cs-p.x*sn;
          const r=R+Math.sin(p.y*11-t*3+p.a*.03)*wave+Math.sin(p.a*.17+t*2)*ripple;
          vx+=x*r;vy+=p.y*r;vz+=z*r;
        }
        if(wt>.001){
          // Thinking: a braided toroidal knot. The same points change topology.
          const theta=p.u*tau*3+t*.57,phi=p.u*tau*8-t*.48,rt=137+41*Math.cos(phi)+24*p.sa;
          const bx=rt*Math.cos(theta),bz=rt*Math.sin(theta),by=65*Math.sin(phi)+17*p.y;
          vx+=bx*wt;vy+=(by*.77-bz*.52)*wt;vz+=(by*.52+bz*.77)*wt;
        }
        if(ws>.001){
          // Searching: three tilted orbital bands with moving bright heads.
          const band=i%3,angle=p.u*tau*5+t*(.7+band*.2),radius=196+11*p.sa;
          const sx=Math.cos(angle)*radius,sy=Math.sin(angle)*radius;
          const sy2=sy*bandTilt[band][0],sz=sy*bandTilt[band][1],cr=bandTilt[band][2],sr=bandTilt[band][3];
          vx+=(sx*cr-sy2*sr)*ws;vy+=(sx*sr+sy2*cr)*ws;vz+=sz*ws;
        }
        if(wd>.001){
          // Done: a particle seal and a legible tick.
          if(i<ring){const q=i/ring*tau,rr=173+9*p.sa;vx+=Math.cos(q)*rr*wd;vy+=Math.sin(q)*rr*wd;vz+=8*p.sa*wd;}
          else{const q=(i-ring)/(count-ring),first=q<.38,v=first?q/.38:(q-.38)/.62;
            vx+=((first?-81+58*v:-23+116*v)+6*p.sa)*wd;vy+=((first?57*v:57-133*v)+6*p.ca)*wd;}
        }
        const depth=(vz+240)/480,persp=850/(850-vz),alpha=.22+.72*depth;
        const r=(.8+depth*1.35)*(.75+.25*Math.sin(p.a+t*1.6))*fine,o=i*5;
        buf[o]=(360+vx*persp)*unit;buf[o+1]=(360+vy*persp)*unit;buf[o+2]=r*9*unit;
        buf[o+3]=Math.min(1,alpha*light);buf[o+4]=vz>75?(alpha-.5)*.75*light:0;
      }
      if(this.gl)this.drawGL(buf,count,rgb,size,spark);else this.draw2D(buf,count,color,size,spark.join(','));
    }
    drawGL(buf,count,rgb,size,spark){
      const {gl,res,col,spk}=this.gl;
      gl.viewport(0,0,size,size);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(res,size,size);gl.uniform3f(col,rgb[0]/255,rgb[1]/255,rgb[2]/255);gl.uniform3f(spk,spark[0]/255,spark[1]/255,spark[2]/255);
      gl.bufferData(gl.ARRAY_BUFFER,buf.subarray(0,count*5),gl.DYNAMIC_DRAW);gl.drawArrays(gl.POINTS,0,count);
    }
    // Fallback when WebGL is unavailable: same dots through 2D sprites, fine up to ~1000 points.
    draw2D(buf,count,color,size,spark){
      const ctx=this.dctx;
      if(this.spriteColor!==color+spark){this.spriteColor=color+spark;this.dot=sprite(color,.2);this.spark=sprite(spark,.5);}
      ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,size,size);ctx.globalCompositeOperation='lighter';
      for(let i=0;i<count;i++){
        const o=i*5,x=buf[o],y=buf[o+1],s=buf[o+2];
        ctx.globalAlpha=buf[o+3];ctx.drawImage(this.dot,x-s/2,y-s/2,s,s);
        if(buf[o+4]>0){const h=s*.2;ctx.globalAlpha=buf[o+4];ctx.drawImage(this.spark,x-h/2,y-h/2,h,h);}
      }
      ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
    }
  }
  customElements.define('signal-orb',SignalOrb);
})();
