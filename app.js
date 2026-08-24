/* =============================================================
   Consola de Guardia Pediátrica
   Datos: Firestore (solo agregados por día + registros de gestión).
   Las filas individuales de pacientes se procesan en el navegador
   y nunca se envían a la nube.
   ============================================================= */
import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {getAuth,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,
        signOut,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {initializeFirestore,persistentLocalCache,persistentSingleTabManager,
        doc,getDoc,setDoc,collection,getDocs} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {firebaseConfig} from './firebase-config.js';

const app=initializeApp(firebaseConfig);
const auth=getAuth(app);
const db=initializeFirestore(app,{localCache:persistentLocalCache({tabManager:persistentSingleTabManager()})});
let UID=null;

/* =============================================================
   CONSTANTES DEL DOMINIO
   ============================================================= */
const TRIAGE=[{k:1,s:'Rojo',n:'Rojo · Emergencia',c:'var(--t1)'},{k:2,s:'Naranja',n:'Naranja · Urgencia',c:'var(--t2)'},
 {k:3,s:'Amarillo',n:'Amarillo · Urgencia menor',c:'var(--t3)'},{k:4,s:'Verde',n:'Verde · Poco urgente',c:'var(--t4)'},
 {k:5,s:'Azul',n:'Azul · No urgente',c:'var(--t5)'},{k:0,s:'Sin dato',n:'Sin clasificar',c:'var(--mut2)'}];
const DEST=[{k:'alta',n:'Alta a domicilio'},{k:'obs',n:'Observación'},{k:'intern',n:'Internación'},
 {k:'uti',n:'UTI pediátrica'},{k:'deriv',n:'Derivación externa'},{k:'retiro',n:'Retiro sin atención'},
 {k:'obito',n:'Óbito'},{k:'otro',n:'Otro / sin dato'}];
const ENF=[{k:'via',n:'Accesos venosos'},{k:'neb',n:'Nebulizaciones'},{k:'medev',n:'Medicación EV/IM'},
 {k:'cura',n:'Curaciones'},{k:'sonda',n:'Sondajes'},{k:'lab',n:'Tomas de muestra'},
 {k:'monit',n:'Monitoreos continuos'},{k:'otros',n:'Otras prácticas'}];
const FALT=['Adrenalina','Salbutamol','Sol. fisiológica','Oxígeno','Cánulas O₂','Tubos endotraqueales',
 'Máscaras nebulizar','Guantes','Barbijos','Sondas','Vías periféricas','Antitérmicos'];
const EVT=[{k:'paro',n:'Paro cardiorrespiratorio'},{k:'rcp',n:'RCP'},{k:'intub',n:'Intubación de urgencia'},
 {k:'deterioro',n:'Deterioro no detectado'},{k:'medic',n:'Error de medicación'},{k:'nearmiss',n:'Casi-error'},
 {k:'extrav',n:'Extravasación de vía'},{k:'caida',n:'Caída'},{k:'ident',n:'Identificación errónea'},
 {k:'ram',n:'Reacción adversa'},{k:'fuga',n:'Fuga del paciente'},{k:'agres',n:'Agresión al personal'},
 {k:'infra',n:'Falla de infraestructura'},{k:'equipo',n:'Falla de equipo en la atención'},{k:'otro',n:'Otro'}];
const EQTIPO=['Bomba de infusión','Respirador','CPAP / alto flujo','Monitor multiparamétrico','Saturómetro',
 'Desfibrilador','Aspirador','Laringoscopio','Electrocardiógrafo','Otro'];
const EQEST=[{k:'op',n:'Operativo'},{k:'rep',n:'En reparación'},{k:'fs',n:'Fuera de servicio'},{k:'pre',n:'Prestado'}];
const TURNOS3=[{k:'M',n:'Mañana 08–14',ini:8,fin:14},{k:'T',n:'Tarde 14–20',ini:14,fin:20},{k:'N',n:'Noche 20–08',ini:20,fin:8}];
const TURNOS2=[{k:'D',n:'Día 07–19',ini:7,fin:19},{k:'N',n:'Noche 19–07',ini:19,fin:7}];
const BINS=[0,5,10,15,20,30,45,60,90,120,180,240,999]; // minutos, para el histograma de espera
const CFG_DEF={nombre:'Guardia Pediátrica',hosp:'',esquema:3,med:2,enf:3,camas:6,recon:4,lwbs:2,hm:80,
 cob:90,pxe:8,ocup:85,oper:90,map:null,vmapT:{},vmapD:{}};

/* =============================================================
   ESTADO Y SINCRONIZACIÓN
   ============================================================= */
let S={cfg:{...CFG_DEF},equipos:[],stock:[],carros:[{id:'c1',n:'Carro de paro · Guardia'}]};
let B={dias:{},partes:{},checks:{},eventos:{}};   // baldes por mes: {'2026-08':[...]}
let range=7, vista='panel', sub=null, editP=null, editE=null, editK=null;

const $=i=>document.getElementById(i);
const N=v=>{const n=parseFloat(v);return isNaN(n)?0:n};
const pct=(a,b)=>b>0?a/b*100:null;
const f1=v=>(v==null||isNaN(v))?'—':(Math.round(v*10)/10).toLocaleString('es-AR');
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const esd=s=>s?s.slice(8,10)+'/'+s.slice(5,7):'—';
const ym=f=>f.slice(0,7);
const esc=s=>String(s??'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
const turnos=()=>S.cfg.esquema==2?TURNOS2:TURNOS3;
const turnoDe=h=>{for(const t of turnos()){if(t.ini<t.fin){if(h>=t.ini&&h<t.fin)return t.k}
  else if(h>=t.ini||h<t.fin)return t.k}return turnos()[0].k};
const meses=n=>{const o=[],d=new Date();for(let i=0;i<n;i++){o.push(iso(d).slice(0,7));d.setMonth(d.getMonth()-1)}return o};
function toast(m,err){const t=document.createElement('div');t.className='toast'+(err?' err':'');t.textContent=m;
  document.body.appendChild(t);setTimeout(()=>t.remove(),2600)}
function setSync(state,txt){const b=$('syncBox');b.className='sync'+(state?' '+state:'');$('syncTxt').textContent=txt}

const LK='guardia:cache';
function cacheGuardar(){try{localStorage.setItem(LK,JSON.stringify({S,B}))}catch(e){}}
function cacheLeer(){try{const r=localStorage.getItem(LK);if(r){const d=JSON.parse(r);
  S={...S,...d.S};S.cfg={...CFG_DEF,...(d.S.cfg||{})};B={...B,...d.B}}}catch(e){}}

const refDoc=(col,id)=>doc(db,'u',UID,col,id);
async function guardarBase(){
  cacheGuardar();
  try{await setDoc(refDoc('meta','base'),{cfg:S.cfg,equipos:S.equipos,stock:S.stock,carros:S.carros,ts:Date.now()});
    setSync('','sincronizado')}
  catch(e){console.error(e);setSync('off','sin conexión')}
}
async function guardarBalde(col,mes){
  cacheGuardar();
  try{await setDoc(refDoc(col,mes),{items:B[col][mes]||[],ts:Date.now()});setSync('','sincronizado')}
  catch(e){console.error(e);setSync('off','sin conexión')}
}
async function cargarTodo(){
  setSync('off','cargando…');
  try{
    const base=await getDoc(refDoc('meta','base'));
    if(base.exists()){const d=base.data();
      S.cfg={...CFG_DEF,...(d.cfg||{})};S.equipos=d.equipos||[];S.stock=d.stock||[];
      S.carros=(d.carros&&d.carros.length)?d.carros:S.carros}
    // Traigo los baldes a una copia aparte y solo reemplazo si la nube realmente respondió.
    // Así, si la conexión falla a mitad de camino, no borro lo que ya tenía en pantalla.
    const nuevo={dias:{},partes:{},checks:{},eventos:{}};
    for(const col of ['dias','partes','checks','eventos']){
      const snap=await getDocs(collection(db,'u',UID,col));
      snap.forEach(x=>nuevo[col][x.id]=x.data().items||[]);
    }
    B=nuevo;
    cacheGuardar();setSync('','sincronizado');
  }catch(e){console.error(e);setSync('err','sin conexión · datos locales')}
}
const items=(col,ms)=>ms.flatMap(m=>B[col][m]||[]);
function guardarItem(col,it){
  const m=ym(it.fecha||it.f);(B[col][m]=B[col][m]||[]);
  const i=B[col][m].findIndex(x=>x.id===it.id);
  if(i>=0)B[col][m][i]=it;else B[col][m].push(it);
  guardarBalde(col,m);
}
function borrarItem(col,id,fecha){const m=ym(fecha);
  B[col][m]=(B[col][m]||[]).filter(x=>x.id!==id);guardarBalde(col,m)}

/* =============================================================
   IMPORTACIÓN DEL EXCEL  (todo local; sube solo el resumen del día)
   ============================================================= */
const CAMPOS=[
 {k:'fecha',n:'Fecha de atención',req:1,rx:/^ingreso$|^fec|fch|^d[ií]a|^fecha/i},
 {k:'hora',n:'Hora de ingreso',rx:/^horai$|hora.?ingr|ingr.?hora|hora.?admis|hora.?entrada/i},
 {k:'horaA',n:'Hora de atención médica',rx:/^hora$|hora.?at|hora.?med|hora.?consul|hora.?inicio/i},
 {k:'hc',n:'Historia clínica',rx:/hist|\bhc\b|clinic/i},
 {k:'dni',n:'Documento',rx:/dni|documento|\bdoc\b/i},
 {k:'edadA',n:'Edad en años',rx:/edad.*a[nñ]|a[nñ]os/i},
 {k:'edadM',n:'Edad en meses',rx:/edad.*mes|meses/i},
 {k:'fnac',n:'Fecha de nacimiento',rx:/nacim|f\.?nac/i},
 {k:'sexo',n:'Sexo',rx:/^sexo|g[eé]nero/i},
 {k:'triage',n:'Nivel de triage',rx:/triage|triaje|categor|prioridad|^nivel|color|gravedad/i},
 {k:'dx',n:'Diagnóstico o motivo',rx:/^diag.?egr|diag.*egr|^diagegre|diagn|\bdx\b|patolog|cie/i},
 {k:'destino',n:'Destino o egreso',rx:/^destino|^egreso|conducta|^resultado|derivac/i},
 {k:'internCol',n:'Columna que marca internación',rx:/motivo.?intern|^motivoi$|intern/i},
 {k:'prof',n:'Profesional que atendió',rx:/^medico$|m[eé]dic|profesion|efector|agente/i}
];
const MESES={ene:1,jan:1,feb:2,mar:3,abr:4,apr:4,may:5,jun:6,jul:7,ago:8,aug:8,sep:9,set:9,oct:10,nov:11,dic:12,dec:12};
let IMP=null;

function excelDate(v){if(typeof v==='number'&&v>20000&&v<80000){
  const d=new Date(Math.round((v-25569)*86400000));return new Date(d.getTime()+d.getTimezoneOffset()*60000)}return null}
function toFecha(v){
  if(v==null||v==='')return null;
  if(v instanceof Date&&!isNaN(v))return iso(v);
  const ed=excelDate(v);if(ed)return iso(ed);
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);if(m)return `${m[1]}-${m[2]}-${m[3]}`;
  m=s.match(/^(\d{1,2})[\/\-. ]+([a-zA-Zá-úÁ-Ú]{3,})[\/\-. ]+(\d{2,4})/);
  if(m){const mm=MESES[m[2].slice(0,3).toLowerCase()];
    if(mm){let y=m[3];if(y.length===2)y='20'+y;
      return `${y}-${String(mm).padStart(2,'0')}-${m[1].padStart(2,'0')}`}}
  m=s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if(m){let y=m[3];if(y.length===2)y='20'+y;return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`}
  const d=new Date(s);return isNaN(d)?null:iso(d);
}
function toMin(v,fv){
  if(v==null||v===''){
    if(typeof fv==='number'){const f=fv%1;return f>0?Math.round(f*1440):null}
    if(fv instanceof Date)return fv.getHours()*60+fv.getMinutes();
    const m=String(fv??'').match(/(\d{1,2}):(\d{2})/);return m?+m[1]*60+ +m[2]:null}
  if(v instanceof Date&&!isNaN(v))return v.getHours()*60+v.getMinutes();
  if(typeof v==='number')return v<1?Math.round(v*1440):(v<24?Math.round(v*60):null);
  const m=String(v).match(/(\d{1,2}):(\d{2})/);if(m)return +m[1]*60+ +m[2];
  const n=parseInt(v);return isNaN(n)||n>23?null:n*60;
}
const limpiaDx=s=>String(s??'').replace(/#/g,'Ñ').replace(/\s+/g,' ').trim()
  .replace(/,\s*(sin otra especificaci[oó]n|no especificad[oa]s?|no clasificad[oa]s? en otra parte)\.?$/i,'').slice(0,60);
function normTriage(v){const s=String(v??'').trim().toLowerCase();if(!s)return 0;
  if(S.cfg.vmapT[s]!=null)return S.cfg.vmapT[s];
  const d=s.match(/[1-5]/);if(d&&!/[a-z]/.test(s))return +d[0];
  if(/roj|red|^i$|emerg|critic/.test(s))return 1;
  if(/naranj|orange|^ii$|urgen/.test(s)&&!/menor|poco/.test(s))return 2;
  if(/amarill|yellow|^iii$|menor/.test(s))return 3;
  if(/verde|green|^iv$|poco/.test(s))return 4;
  if(/azul|blue|^v$|no urg/.test(s))return 5;return 0}
function normDest(v){const s=String(v??'').trim().toLowerCase();if(!s)return 'otro';
  if(S.cfg.vmapD[s])return S.cfg.vmapD[s];
  if(/uti|uci|terapia|critic/.test(s))return 'uti';
  if(/intern|sala|piso|ingres/.test(s))return 'intern';
  if(/observ/.test(s))return 'obs';
  if(/deriv|traslad|refer/.test(s))return 'deriv';
  if(/retir|voluntar|abandon|no esper|fuga|ausent/.test(s))return 'retiro';
  if(/obito|fallec|defunc|muert/.test(s))return 'obito';
  if(/alta|domicil|ambulat/.test(s))return 'alta';return 'otro'}
function autoMap(h){const m={};CAMPOS.forEach(c=>{const i=h.findIndex(x=>c.rx.test(String(x)));if(i>=0)m[c.k]=i});return m}
function parseCSV(txt){
  const d=(txt.match(/;/g)||[]).length>(txt.match(/,/g)||[]).length?';':',';
  const out=[];let row=[],cell='',q=false;
  for(let i=0;i<txt.length;i++){const c=txt[i];
    if(q){if(c==='"'){if(txt[i+1]==='"'){cell+='"';i++}else q=false}else cell+=c}
    else if(c==='"')q=true;else if(c===d){row.push(cell);cell=''}
    else if(c==='\n'){row.push(cell);out.push(row);row=[];cell=''}else if(c!=='\r')cell+=c}
  if(cell||row.length){row.push(cell);out.push(row)}
  return out.filter(r=>r.some(x=>String(x).trim()!==''))}

function filas(){
  const m=S.cfg.map,out=[];
  IMP.rows.forEach(r=>{
    const f=toFecha(r[m.fecha]);if(!f)return;
    const mi=m.hora!=null?toMin(r[m.hora],r[m.fecha]):toMin(null,r[m.fecha]);
    const ma=m.horaA!=null?toMin(r[m.horaA],null):null;
    let esp=null;if(mi!=null&&ma!=null){esp=ma-mi;if(esp<0)esp+=1440;if(esp>360)esp=null}
    let em=null;
    if(m.edadM!=null&&r[m.edadM]!=='')em=Math.round(N(r[m.edadM]));
    else if(m.edadA!=null&&r[m.edadA]!=='')em=Math.round(N(r[m.edadA])*12);
    else if(m.fnac!=null){const fn=toFecha(r[m.fnac]);if(fn)em=Math.round((new Date(f)-new Date(fn))/(30.44*86400000))}
    let de=m.destino!=null?normDest(r[m.destino]):null;
    if(m.internCol!=null&&String(r[m.internCol]??'').trim()!=='')de='intern';
    else if(de==null)de=m.internCol!=null?'alta':'otro';
    out.push({f,hr:mi==null?null:Math.floor(mi/60),esp,em,tri:m.triage!=null?normTriage(r[m.triage]):0,
      dx:m.dx!=null?limpiaDx(r[m.dx]):'',pr:m.prof!=null?String(r[m.prof]??'').trim().slice(0,40):'',de})});
  return out;
}
/* Convierte las filas en un resumen por día. Solo esto sale del navegador. */
function resumir(rows){
  const porDia={};
  rows.forEach(r=>{
    const d=porDia[r.f]=porDia[r.f]||{id:r.f,f:r.f,n:0,h:Array(24).fill(0),tri:{},de:{},t:{},
      espN:0,espSum:0,espH:Array(BINS.length).fill(0),espT:{},dx:{},pr:{}};
    d.n++;
    if(r.hr!=null){d.h[r.hr]++;const tk=turnoDe(r.hr);d.t[tk]=(d.t[tk]||0)+1;
      if(r.esp!=null)(d.espT[tk]=d.espT[tk]||[]).push(r.esp)}
    d.tri[r.tri]=(d.tri[r.tri]||0)+1;
    d.de[r.de]=(d.de[r.de]||0)+1;
    if(r.esp!=null){d.espN++;d.espSum+=r.esp;
      let b=BINS.findIndex(x=>r.esp<=x);if(b<0)b=BINS.length-1;d.espH[b]++}
    if(r.dx)d.dx[r.dx]=(d.dx[r.dx]||0)+1;
    if(r.pr)d.pr[r.pr]=(d.pr[r.pr]||0)+1;
  });
  return Object.values(porDia).map(d=>{
    Object.keys(d.espT).forEach(k=>{const v=d.espT[k];
      d.espT[k]=Math.round(v.reduce((a,b)=>a+b,0)/v.length)});
    // Firestore no admite arrays dentro de arrays. Guardo dx y pr como objeto {clave:cantidad}.
    const top=(obj,n)=>{const e=Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,n);
      return Object.fromEntries(e)};
    d.dx=top(d.dx,15);
    d.pr=top(d.pr,12);
    return d});
}

/* =============================================================
   INDICADORES
   ============================================================= */
function desde(d){const l=new Date();l.setHours(0,0,0,0);l.setDate(l.getDate()-(d-1));return iso(l)}
function dias(d){const l=desde(d);return items('dias',meses(5)).filter(x=>x.f>=l)}
function partes(d){const l=desde(d);return items('partes',meses(5)).filter(x=>x.fecha>=l)}

function aggDias(d){
  const L=dias(d),z={ndias:L.length,n:0,h:Array(24).fill(0),tri:{},de:{},t:{},espN:0,espSum:0,
    espH:Array(BINS.length).fill(0),espT:{},dx:{},pr:{}};
  TRIAGE.forEach(x=>z.tri[x.k]=0);DEST.forEach(x=>z.de[x.k]=0);
  const espTn={};
  L.forEach(d2=>{z.n+=d2.n;
    (d2.h||[]).forEach((v,i)=>z.h[i]+=v);
    Object.entries(d2.tri||{}).forEach(([k,v])=>z.tri[k]=(z.tri[k]||0)+v);
    Object.entries(d2.de||{}).forEach(([k,v])=>z.de[k]=(z.de[k]||0)+v);
    Object.entries(d2.t||{}).forEach(([k,v])=>z.t[k]=(z.t[k]||0)+v);
    z.espN+=d2.espN||0;z.espSum+=d2.espSum||0;
    (d2.espH||[]).forEach((v,i)=>z.espH[i]+=v);
    Object.entries(d2.espT||{}).forEach(([k,v])=>{z.espT[k]=(z.espT[k]||0)+v;espTn[k]=(espTn[k]||0)+1});
    const ent=x=>Array.isArray(x)?x:Object.entries(x||{});
    ent(d2.dx).forEach(([k,v])=>z.dx[k]=(z.dx[k]||0)+v);
    ent(d2.pr).forEach(([k,v])=>z.pr[k]=(z.pr[k]||0)+v)});
  Object.keys(z.espT).forEach(k=>z.espT[k]=Math.round(z.espT[k]/espTn[k]));
  const qb=p=>{if(!z.espN)return null;let acc=0,lim=z.espN*p;
    for(let i=0;i<z.espH.length;i++){acc+=z.espH[i];if(acc>=lim)return BINS[i]}return BINS[BINS.length-1]};
  z.espMed=qb(.5);z.espP90=qb(.9);z.espProm=z.espN?z.espSum/z.espN:null;
  const le=x=>{let a=0;for(let i=0;i<BINS.length;i++){if(BINS[i]<=x)a+=z.espH[i]}return a};
  z.pEsp15=z.espN?pct(le(15),z.espN):null;z.pEsp30=z.espN?pct(le(30),z.espN):null;
  z.porDia=z.n/Math.max(1,d);
  z.pUrg=pct(z.tri[1]+z.tri[2],z.n);z.pAmb=pct(z.tri[4]+z.tri[5],z.n);
  z.pIntern=pct(z.de.intern+z.de.uti,z.n);z.pLwbs=pct(z.de.retiro,z.n);
  z.dxTop=Object.entries(z.dx).sort((a,b)=>b[1]-a[1]).slice(0,10);
  z.prTop=Object.entries(z.pr).sort((a,b)=>b[1]-a[1]).slice(0,10);
  z.picoHora=z.h.indexOf(Math.max(...z.h));
  z.diaPico=L.length?Math.max(...L.map(x=>x.n)):0;
  z.serie=(()=>{const o=[],hoy=new Date();
    for(let i=d-1;i>=0;i--){const x=new Date(hoy);x.setDate(x.getDate()-i);const k=iso(x);
      const r=L.find(y=>y.f===k);o.push(r?r.n:0)}return o})();
  return z;
}
function aggPartes(d){
  const L=partes(d),z={n:L.length,enf:{},procs:0,medP:0,medPl:0,enfP:0,enfPl:0,aus:0,hs:0,
    camO:0,camT:0,board:0,hmObs:0,hmOk:0,falt:{}};
  ENF.forEach(e=>z.enf[e.k]=0);
  L.forEach(p=>{ENF.forEach(e=>{z.enf[e.k]+=N(p.e?.[e.k]);z.procs+=N(p.e?.[e.k])});
    ['medP','medPl','enfP','enfPl','aus','hs','camO','camT','board','hmObs','hmOk'].forEach(k=>z[k]+=N(p[k]));
    (p.falt||[]).forEach(f=>z.falt[f]=(z.falt[f]||0)+1)});
  z.cobEnf=pct(z.enfP,z.enfPl);z.cobMed=pct(z.medP,z.medPl);
  z.ocup=pct(z.camO,z.camT);z.pHM=pct(z.hmOk,z.hmObs);
  z.faltTop=Object.entries(z.falt).sort((a,b)=>b[1]-a[1]).slice(0,6);
  return z;
}
function aggEq(){
  const z={tot:S.equipos.length,op:0,rep:0,fs:0,pre:0,porTipo:{},pmVenc:0,diasFS:0,mttr:[],stockBajo:[]};
  const hoy=iso(new Date());
  S.equipos.forEach(e=>{z[e.est]=(z[e.est]||0)+1;
    const t=z.porTipo[e.tipo]=z.porTipo[e.tipo]||{t:0,o:0};t.t++;if(e.est==='op')t.o++;
    if(e.pm&&e.pm<hoy)z.pmVenc++;
    if(e.est!=='op'&&e.desde)z.diasFS+=Math.max(0,(new Date(hoy)-new Date(e.desde))/86400000);
    (e.hist||[]).forEach(h=>z.mttr.push(h.d))});
  z.pOper=pct(z.op,z.tot);
  z.mttrProm=z.mttr.length?z.mttr.reduce((a,b)=>a+b,0)/z.mttr.length:null;
  S.stock.forEach(s=>{if(N(s.cant)<N(s.min))z.stockBajo.push(s)});
  const b=z.porTipo['Bomba de infusión'];z.bombasOp=b?b.o:0;
  z.bombasPorCama=S.cfg.camas>0?z.bombasOp/S.cfg.camas:null;
  return z;
}
function aggCarro(d){
  const l=desde(d),C=items('checks',meses(5)).filter(c=>c.fecha>=l);
  const esperados=turnos().length*d*Math.max(1,S.carros.length);
  const z={n:C.length,esperados,adh:pct(C.length,esperados),
    hall:C.filter(c=>!c.precinto||!c.desf||!c.via||!c.med||!c.o2||N(c.venc)>0).length,
    venc:C.reduce((a,c)=>a+N(c.venc),0),
    rep:C.filter(c=>c.usado&&c.rep!==''&&c.rep!=null).map(c=>N(c.rep))};
  z.pHall=pct(z.hall,C.length);
  z.repProm=z.rep.length?z.rep.reduce((a,b)=>a+b,0)/z.rep.length:null;
  const todos=items('checks',meses(12));
  z.porCarro=S.carros.map(c=>{const u=todos.filter(x=>x.carro===c.id).sort((a,b)=>b.fecha.localeCompare(a.fecha))[0];
    return {...c,ult:u?u.fecha:null,dias:u?Math.floor((new Date(iso(new Date()))-new Date(u.fecha))/86400000):null}});
  return z;
}
function aggEv(d,consultas){
  const l=desde(d),E=items('eventos',meses(5)).filter(e=>e.fecha>=l);
  const z={n:E.length,tipo:{},abiertos:0,cerrados:0,ds:[],graves:0};
  E.forEach(e=>{z.tipo[e.tipo]=(z.tipo[e.tipo]||0)+1;
    if(e.est==='cerrado'){z.cerrados++;if(e.cierre)z.ds.push((new Date(e.cierre)-new Date(e.fecha))/86400000)}
    else z.abiertos++;
    if(N(e.grav)>=3)z.graves++});
  z.tasa=consultas?z.n/consultas*1000:null;z.pCerr=pct(z.cerrados,z.n);
  z.diasProm=z.ds.length?z.ds.reduce((a,b)=>a+b,0)/z.ds.length:null;
  return z;
}

/* =============================================================
   PIEZAS VISUALES
   ============================================================= */
const kpi=(k,v,u,f,s)=>`<div class="kpi ${s||''}"><div class="k">${k}</div>
  <div class="v">${v}${u?`<small> ${u}</small>`:''}</div>${f?`<div class="f">${f}</div>`:''}</div>`;
const bars=(it,tot,cf)=>it.map(x=>{const p=tot>0?x.v/tot*100:0;
  const tip=tot>0?`${esc(x.n)}: ${x.v} · ${f1(p)} %`:`${esc(x.n)}: ${x.v}`;
  return `<div class="brow" title="${tip}"><span>${esc(x.n)}</span>
  <span class="bar"><i style="width:${p.toFixed(1)}%;background:${cf(x)}"></i></span>
  <span class="n">${x.v}</span></div>`}).join('');
const est=(v,meta,mayor)=>(v==null||isNaN(v))?'':(mayor?(v>=meta?'hi':v>=meta*.9?'warn':'bad'):(v<=meta?'hi':v<=meta*1.25?'warn':'bad'));

/* =============================================================
   VISTA · PANEL
   ============================================================= */
function vPanel(){
  const A=aggDias(range),P=aggPartes(range),E=aggEq(),C=aggCarro(range),V=aggEv(range,A.n),c=S.cfg;
  const box=$('v-panel');
  if(!A.n&&!P.n&&!S.equipos.length){
    box.innerHTML=`<div class="card empty" style="margin-top:12px"><h3>Todavía no hay datos</h3>
      <p>Importá el Excel del día desde la computadora, o cargá el parte del turno desde acá.</p>
      <div class="actions" style="justify-content:center">
        <button class="btn" data-go="cargar">Cargar parte</button>
        <button class="btn gh" data-go="importar">Importar Excel</button></div></div>`;
    box.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));return}

  const AL=[],add=(l,t,w)=>AL.push({l,t,w});
  const pxe=P.enfP?A.n/P.enfP:null;
  if(A.pLwbs>c.lwbs)add('crit',`${f1(A.pLwbs)} % se retiró sin ser atendido`,`Meta ${c.lwbs} %. ${A.de.retiro} pacientes.`);
  if(P.cobEnf!=null&&P.cobEnf<c.cob)add('crit',`Cobertura de enfermería ${f1(P.cobEnf)} %`,`Meta ${c.cob} %. ${P.aus} ausencias sin reemplazo.`);
  if(pxe!=null&&pxe>c.pxe)add('crit',`${f1(pxe)} pacientes por enfermera/o`,`Máximo definido ${c.pxe}.`);
  C.porCarro.forEach(x=>{if(x.dias==null)add('crit',`${x.n} sin controles`,'Registrá el primero para activar el seguimiento.');
    else if(x.dias>1)add('crit',`${x.n}: ${x.dias} días sin control`,`Último el ${esd(x.ult)}.`)});
  if(A.espP90!=null&&A.espP90>30)add('med',`Uno de cada diez espera más de ${A.espP90} min`,`Mediana de ${A.espMed} min.`);
  if(E.pOper!=null&&E.pOper<c.oper)add('med',`Operatividad de equipos ${f1(E.pOper)} %`,`${E.rep||0} en reparación, ${E.fs||0} fuera de servicio.`);
  if(E.pmVenc)add('med',`${E.pmVenc} equipos con mantenimiento vencido`,'Corresponde pedido a bioingeniería.');
  if(E.stockBajo.length)add('med',`${E.stockBajo.length} ítems bajo mínimo`,E.stockBajo.map(s=>s.n).join(', '));
  if(V.abiertos)add('med',`${V.abiertos} eventos sin cerrar`,`${V.graves} con daño moderado o mayor.`);
  if(P.pHM!=null&&P.pHM<c.hm)add('med',`Higiene de manos ${f1(P.pHM)} %`,`Meta ${c.hm} %, sobre ${P.hmObs} oportunidades.`);
  if(P.ocup!=null&&P.ocup>c.ocup)add('med',`Observación al ${f1(P.ocup)} %`,`${P.board} pacientes esperaron cama.`);
  if(!AL.length)add('ok','Sin desvíos frente a las metas',`${A.n} atenciones y ${P.n} turnos analizados.`);

  const mx=Math.max(1,...A.h);
  const h=[`<div style="display:flex;gap:9px;align-items:center;margin:12px 0 11px;flex-wrap:wrap">
    <div class="seg" id="seg">${[7,30,90].map(r=>`<button data-r="${r}" aria-pressed="${r===range}">${r} días</button>`).join('')}</div>
    <span style="color:var(--mut2);font-size:12px">${A.n} atenciones · ${P.n} partes</span></div>`,

  `<div class="card"><h2>Qué mirar hoy</h2>${AL.map(x=>`<div class="alert ${x.l}">
    <span class="pill">${x.l==='crit'?'Crítico':x.l==='med'?'Atender':'En meta'}</span>
    <span class="txt">${x.t}<span class="why">${x.w}</span></span></div>`).join('')}</div>`,

  `<div class="grid g2">
    ${kpi('Atenciones',A.n,'',`${f1(A.porDia)} por día · pico ${A.diaPico}`,'hi')}
    ${kpi('Internación',f1(A.pIntern),'%',`${A.de.intern+A.de.uti} pases`,'')}
    ${A.espN?kpi('Espera mediana',A.espMed,'min',`p90 ${A.espP90} min`,est(A.espMed,15,false))
      :kpi('Urgencia real',f1(A.pUrg),'%',`${A.tri[1]+A.tri[2]} rojo + naranja`,'')}
    ${A.espN?kpi('Atendidos ≤15 min',f1(A.pEsp15),'%',`${f1(A.pEsp30)} % dentro de 30`,est(A.pEsp15,80,true))
      :kpi('Retiro sin atención',f1(A.pLwbs),'%',`Meta ${c.lwbs} %`,est(A.pLwbs,c.lwbs,false))}</div>`];

  if(A.n)h.push(`<div class="card"><h2>Cuándo llega la demanda</h2>
    <div class="hourbars">${A.h.map((v,i)=>`<i class="${i===A.picoHora?'pk':''}" style="height:${(v/mx*100).toFixed(1)}%"
      title="${String(i).padStart(2,'0')}:00 · ${v} ${v===1?'atención':'atenciones'}"
      >${v>0?`<b>${v}</b>`:''}</i>`).join('')}</div>
    <div class="hourlbl"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
    <p class="hint">Pico a las ${String(A.picoHora).padStart(2,'0')}:00, turno ${turnoDe(A.picoHora)}.
    ${Object.entries(A.t).map(([k,v])=>`${k} ${v}`).join(' · ')}</p></div>`);

  if(A.espN)h.push(`<div class="card"><h2>Espera hasta el registro médico</h2>
    <div class="grid g3">${kpi('Mediana',A.espMed,'min','','')}${kpi('p90',A.espP90,'min','',est(A.espP90,30,false))}
      ${kpi('Promedio',f1(A.espProm),'min','','')}</div>
    <div style="margin-top:10px">${bars(turnos().map(t=>({n:t.n,v:A.espT[t.k]||0})),
      Math.max(1,...Object.values(A.espT)),x=>x.v>30?'var(--t1)':x.v>15?'var(--t3)':'var(--t4)')}</div></div>`);

  if(A.n)h.push(`<div class="card"><h2>Destino</h2>
    ${bars(DEST.filter(d=>A.de[d.k]).map(d=>({n:d.n,v:A.de[d.k],k:d.k})),A.n,
      x=>x.k==='alta'?'var(--t4)':x.k==='obs'?'var(--t3)':x.k==='retiro'?'var(--t1)':'var(--t5)')}</div>`);

  if(A.dxTop.length)h.push(`<div class="card"><h2>Motivos más frecuentes</h2>
    ${bars(A.dxTop.map(([n,v])=>({n:n.slice(0,24),v})),A.dxTop[0][1],()=>'var(--t4)')}</div>`);

  h.push(`<div class="card"><h2>Enfermería y dotación</h2>
    <div class="grid g2">
      ${kpi('Prácticas',P.procs,'',`${f1(P.procs/Math.max(1,P.n))} por turno`,'')}
      ${kpi('Pacientes por enf.',f1(pxe),'',`Máx ${c.pxe}`,est(pxe,c.pxe,false))}
      ${kpi('Cobertura enfermería',f1(P.cobEnf),'%',`${P.enfP} de ${P.enfPl}`,est(P.cobEnf,c.cob,true))}
      ${kpi('Cobertura médica',f1(P.cobMed),'%',`${P.medP} de ${P.medPl}`,est(P.cobMed,c.cob,true))}
      ${kpi('Ausencias',P.aus,'','Sin reemplazo',P.aus?'warn':'hi')}
      ${kpi('Horas extra',P.hs,'h','Costo de la brecha','')}</div>
    ${P.procs?`<div style="margin-top:10px">${bars(ENF.map(e=>({n:e.n,v:P.enf[e.k]})),
      Math.max(1,...ENF.map(e=>P.enf[e.k])),()=>'var(--t5)')}</div>`:''}</div>`);

  h.push(`<div class="card"><h2>Equipos, carro de paro y eventos</h2>
    <div class="grid g2">
      ${kpi('Operatividad',f1(E.pOper),'%',`${E.op} de ${E.tot}`,est(E.pOper,c.oper,true))}
      ${kpi('Días-equipo perdidos',Math.round(E.diasFS),'','Acumulado',E.diasFS?'warn':'hi')}
      ${kpi('Control del carro',f1(C.adh),'%',`${C.n} de ${C.esperados}`,est(C.adh,90,true))}
      ${kpi('Con hallazgo',f1(C.pHall),'%',`${C.hall} controles`,C.pHall>20?'warn':'hi')}
      ${kpi('Eventos',V.n,'',`${V.graves} con daño`,V.graves?'bad':'')}
      ${kpi('Sin cerrar',V.abiertos,'',`${f1(V.pCerr)} % cerrados`,V.abiertos?'warn':'hi')}</div></div>`);

  box.innerHTML=h.join('');
  box.querySelectorAll('#seg button').forEach(b=>b.onclick=()=>{range=+b.dataset.r;vPanel()});
}

/* =============================================================
   VISTA · CARGAR  (hub + tres formularios)
   ============================================================= */
function vCargar(){
  const box=$('v-cargar');
  if(!sub){
    const C=aggCarro(range),alerta=C.porCarro.some(x=>x.dias==null||x.dias>1);
    const pend=pendientes();
    box.innerHTML=`<div style="margin:12px 0 11px" class="hub">
      <button class="hubb" data-s="parte"><b>Parte de turno</b><span>${pend.length?pend.length+' pendientes':'Dotación, prácticas, camas'}</span></button>
      <button class="hubb ${alerta?'al':''}" data-s="carro"><b>Carro de paro</b><span>${
        C.porCarro.map(x=>x.dias==null?'sin control':x.dias+' d').join(' · ')}</span></button>
      <button class="hubb" data-s="evento"><b>Evento crítico</b><span>Registro y seguimiento</span></button>
      <button class="hubb" data-s="hist"><b>Ver lo cargado</b><span>Partes, controles y eventos</span></button>
    </div>${pend.length?`<div class="notice"><b>${pend.length} partes pendientes.</b>
      ${pend.slice(0,10).map(x=>`<button class="chip ${x.t}" style="cursor:pointer;margin:5px 4px 0 0" data-pd="${x.d}" data-pt="${x.t}">${esd(x.d)} ${x.t}</button>`).join('')}</div>`:''}`;
    box.querySelectorAll('[data-s]').forEach(b=>b.onclick=()=>{sub=b.dataset.s;vCargar()});
    box.querySelectorAll('[data-pd]').forEach(b=>b.onclick=()=>{
      sub='parte';editP={fecha:b.dataset.pd,turno:b.dataset.pt};vCargar()});
    return}
  const volver=`<button class="btn gh sm" id="volver" style="margin:12px 0 10px">← Volver</button>`;
  if(sub==='parte')box.innerHTML=volver+formParte();
  if(sub==='carro')box.innerHTML=volver+formCarro();
  if(sub==='evento')box.innerHTML=volver+formEvento();
  if(sub==='hist')box.innerHTML=volver+historial();
  $('volver').onclick=()=>{sub=null;editP=null;editE=null;editK=null;vCargar()};
  if(sub==='parte')bindParte();if(sub==='carro')bindCarro();
  if(sub==='evento')bindEvento();if(sub==='hist')bindHist();
}
function pendientes(){
  const ds=[...new Set(dias(14).map(x=>x.f))].sort().reverse();
  const P=items('partes',meses(3)),out=[];
  ds.forEach(d=>turnos().forEach(t=>{if(!P.some(p=>p.fecha===d&&p.turno===t.k))out.push({d,t:t.k})}));
  return out;
}
function formParte(){
  const p=editP||{},ayer=iso(new Date(Date.now()-864e5));
  const to=turnos().map(t=>`<option value="${t.k}" ${p.turno===t.k?'selected':''}>${t.n}</option>`).join('');
  return `<form id="fParte">
   <fieldset><legend>Turno</legend>
    <div class="grid g2">
     <div class="field"><label>Fecha</label><input type="date" id="p_fecha" value="${p.fecha||ayer}" required></div>
     <div class="field"><label>Turno</label><select id="p_turno">${to}</select></div></div>
     <div class="field"><label>Responsable</label><input type="text" id="p_jefe" value="${esc(p.jefe||'')}" style="font-family:var(--body)"></div>
     <div class="hint" id="p_auto"></div></fieldset>
   <fieldset><legend>Dotación</legend><div class="grid g2">
     <div class="field"><label>Médicos presentes</label><input type="number" inputmode="numeric" id="p_medP" value="${p.medP??S.cfg.med}"></div>
     <div class="field"><label>Médicos planificados</label><input type="number" inputmode="numeric" id="p_medPl" value="${p.medPl??S.cfg.med}"></div>
     <div class="field"><label>Enfermería presente</label><input type="number" inputmode="numeric" id="p_enfP" value="${p.enfP??S.cfg.enf}"></div>
     <div class="field"><label>Enfermería planificada</label><input type="number" inputmode="numeric" id="p_enfPl" value="${p.enfPl??S.cfg.enf}"></div>
     <div class="field"><label>Ausencias sin reemplazo</label><input type="number" inputmode="numeric" id="p_aus" value="${p.aus??''}"></div>
     <div class="field"><label>Horas extra</label><input type="number" inputmode="numeric" id="p_hs" value="${p.hs??''}"></div>
   </div></fieldset>
   <fieldset><legend>Prácticas de enfermería</legend><div class="grid g2">
     ${ENF.map(e=>`<div class="field"><label>${e.n}</label>
       <input type="number" inputmode="numeric" id="pe_${e.k}" value="${p.e?.[e.k]??''}"></div>`).join('')}
   </div></fieldset>
   <fieldset><legend>Camas e higiene de manos</legend><div class="grid g2">
     <div class="field"><label>Observación ocupadas (pico)</label><input type="number" inputmode="numeric" id="p_camO" value="${p.camO??''}"></div>
     <div class="field"><label>Observación habilitadas</label><input type="number" inputmode="numeric" id="p_camT" value="${p.camT??S.cfg.camas}"></div>
     <div class="field"><label>Esperando cama de internación</label><input type="number" inputmode="numeric" id="p_board" value="${p.board??''}"></div>
     <div class="field"><label>Oportunidades observadas</label><input type="number" inputmode="numeric" id="p_hmObs" value="${p.hmObs??''}"></div>
     <div class="field"><label>Oportunidades cumplidas</label><input type="number" inputmode="numeric" id="p_hmOk" value="${p.hmOk??''}"></div>
   </div></fieldset>
   <fieldset><legend>Faltantes del turno</legend>
     ${FALT.map((f,i)=>`<label class="check" style="padding:9px 11px;min-height:42px">
       <input type="checkbox" id="pf_${i}" ${(p.falt||[]).includes(f)?'checked':''}><span>${f}</span></label>`).join('')}
   </fieldset>
   <fieldset><legend>Novedades</legend>
     <textarea id="p_obs" placeholder="Lo que los números no muestran">${esc(p.obs||'')}</textarea></fieldset>
   <button type="submit" class="btn wide">Guardar parte</button></form>`;
}
function bindParte(){
  const auto=()=>{const f=$('p_fecha').value,t=turnos().find(x=>x.k===$('p_turno').value);
    const d=items('dias',meses(3)).find(x=>x.f===f);
    $('p_auto').innerHTML=d?`Del Excel: <b style="color:var(--ink)">${d.t?.[t.k]||0} atenciones</b> en este turno, ${d.n} en el día.`
      :'Todavía no importaste el Excel de esa fecha.'};
  $('p_fecha').onchange=auto;$('p_turno').onchange=auto;auto();
  $('fParte').onsubmit=e=>{e.preventDefault();
    const p={id:(editP&&editP.id)||'p'+Date.now(),fecha:$('p_fecha').value,turno:$('p_turno').value,
      jefe:$('p_jefe').value.trim(),e:Object.fromEntries(ENF.map(x=>[x.k,N($('pe_'+x.k).value)])),
      medP:N($('p_medP').value),medPl:N($('p_medPl').value),enfP:N($('p_enfP').value),enfPl:N($('p_enfPl').value),
      aus:N($('p_aus').value),hs:N($('p_hs').value),camO:N($('p_camO').value),camT:N($('p_camT').value),
      board:N($('p_board').value),hmObs:N($('p_hmObs').value),hmOk:N($('p_hmOk').value),
      falt:FALT.filter((f,i)=>$('pf_'+i).checked),obs:$('p_obs').value.trim()};
    const m=ym(p.fecha),dup=(B.partes[m]||[]).find(x=>x.fecha===p.fecha&&x.turno===p.turno&&x.id!==p.id);
    if(dup){if(!confirm('Ya hay un parte de ese turno. ¿Reemplazarlo?'))return;p.id=dup.id}
    guardarItem('partes',p);editP=null;sub=null;vCargar();vPanel();toast('Parte guardado')};
}
function formCarro(){
  const k=editK||{},hoy=iso(new Date());
  const chk=(id,val,def)=>editK?(k[val]?'checked':''):(def?'checked':'');
  return `<form id="fCarro">
   <fieldset><legend>${editK?'Editar control':'Control'}</legend><div class="grid g2">
     <div class="field"><label>Carro</label><select id="k_carro">${S.carros.map(c=>`<option value="${c.id}" ${k.carro===c.id?'selected':''}>${esc(c.n)}</option>`).join('')}</select></div>
     <div class="field"><label>Fecha</label><input type="date" id="k_fecha" value="${k.fecha||hoy}" required></div>
     <div class="field"><label>Turno</label><select id="k_turno">${turnos().map(t=>`<option value="${t.k}" ${k.turno===t.k?'selected':''}>${t.n}</option>`).join('')}</select></div>
     <div class="field"><label>Controló</label><input type="text" id="k_quien" value="${esc(k.quien||'')}" style="font-family:var(--body)"></div>
   </div></fieldset>
   <fieldset><legend>Verificación</legend>
     ${[['k_precinto','precinto','Precinto íntegro y numerado',1],['k_desf','desf','Desfibrilador testeado, batería y parches pediátricos',1],
        ['k_via','via','Set de vía aérea pediátrica completo',1],['k_med','med','Medicación crítica completa y vigente',1],
        ['k_o2','o2','Oxígeno, aspiración y ambú operativos',1],['k_usado','usado','El carro se usó desde el último control',0]]
       .map(([id,val,tx,on])=>`<label class="check ${(editK?k[val]:on)?'on':''}"><input type="checkbox" id="${id}" ${chk(id,val,on)}><span>${tx}</span></label>`).join('')}
     <div class="grid g2" style="margin-top:6px">
       <div class="field"><label>Ítems por vencer (30 días)</label><input type="number" inputmode="numeric" id="k_venc" value="${k.venc??0}"></div>
       <div class="field"><label>Horas hasta reposición</label><input type="number" inputmode="numeric" id="k_rep" value="${k.rep??''}"></div></div>
     <div class="field"><label>Detalle del hallazgo</label><textarea id="k_hall">${esc(k.hall||'')}</textarea></div></fieldset>
   <button type="submit" class="btn wide">${editK?'Guardar cambios':'Guardar control'}</button></form>`;
}
function bindCarro(){
  document.querySelectorAll('#fCarro .check input').forEach(i=>i.onchange=()=>
    i.closest('.check').classList.toggle('on',i.checked));
  $('fCarro').onsubmit=e=>{e.preventDefault();
    guardarItem('checks',{id:(editK&&editK.id)||'k'+Date.now(),carro:$('k_carro').value,fecha:$('k_fecha').value,turno:$('k_turno').value,
      quien:$('k_quien').value.trim(),precinto:$('k_precinto').checked,desf:$('k_desf').checked,via:$('k_via').checked,
      med:$('k_med').checked,o2:$('k_o2').checked,usado:$('k_usado').checked,venc:N($('k_venc').value),
      rep:$('k_rep').value,hall:$('k_hall').value.trim()});
    editK=null;sub=null;vCargar();vPanel();toast('Control guardado')};
}
function formEvento(){
  const e=editE||{},hoy=iso(new Date());
  return `<form id="fEv">
   <fieldset><legend>Evento</legend><div class="grid g2">
     <div class="field"><label>Fecha</label><input type="date" id="e_fecha" value="${e.fecha||hoy}" required></div>
     <div class="field"><label>Turno</label><select id="e_turno">${turnos().map(t=>`<option value="${t.k}" ${e.turno===t.k?'selected':''}>${t.n}</option>`).join('')}</select></div>
     <div class="field"><label>Tipo</label><select id="e_tipo">${EVT.map(x=>`<option value="${x.k}" ${e.tipo===x.k?'selected':''}>${x.n}</option>`).join('')}</select></div>
     <div class="field"><label>Gravedad</label><select id="e_grav">${
       [['1','Sin daño / casi-error'],['2','Daño leve'],['3','Daño moderado'],['4','Daño grave'],['5','Centinela']]
       .map(([v,n])=>`<option value="${v}" ${e.grav===v?'selected':''}>${n}</option>`).join('')}</select></div>
   </div>
   <div class="field"><label>Qué pasó</label><textarea id="e_desc" required>${esc(e.desc||'')}</textarea></div></fieldset>
   <fieldset><legend>Seguimiento</legend>
     <div class="field"><label>Estado</label><select id="e_est">${
       [['abierto','Abierto'],['analisis','En análisis'],['cerrado','Cerrado']]
       .map(([v,n])=>`<option value="${v}" ${e.est===v?'selected':''}>${n}</option>`).join('')}</select></div>
     <div class="field"><label>Acción correctiva</label><input type="text" id="e_acc" value="${esc(e.acc||'')}" style="font-family:var(--body)"></div>
     <div class="field"><label>Fecha de cierre</label><input type="date" id="e_cierre" value="${e.cierre||''}"></div></fieldset>
   <button type="submit" class="btn wide">Guardar evento</button></form>`;
}
function bindEvento(){
  $('fEv').onsubmit=e=>{e.preventDefault();
    guardarItem('eventos',{id:(editE&&editE.id)||'v'+Date.now(),fecha:$('e_fecha').value,turno:$('e_turno').value,
      tipo:$('e_tipo').value,grav:$('e_grav').value,desc:$('e_desc').value.trim(),est:$('e_est').value,
      acc:$('e_acc').value.trim(),cierre:$('e_cierre').value});
    editE=null;sub=null;vCargar();vPanel();toast('Evento registrado')};
}
function historial(){
  const P=items('partes',meses(4)).sort((a,b)=>(b.fecha+b.turno).localeCompare(a.fecha+a.turno)).slice(0,40);
  const K=items('checks',meses(4)).sort((a,b)=>b.fecha.localeCompare(a.fecha)).slice(0,30);
  const V=items('eventos',meses(6)).sort((a,b)=>b.fecha.localeCompare(a.fecha)).slice(0,30);
  const ok=v=>v?'<span class="chip ok">Sí</span>':'<span class="chip bad">No</span>';
  return `<div class="card"><h2>Partes de turno</h2><div class="tblwrap">${P.length?`<table><thead><tr>
    <th>Fecha</th><th>Turno</th><th>Enf.</th><th>Prácticas</th><th></th></tr></thead><tbody>
    ${P.map(p=>`<tr><td class="num">${esd(p.fecha)}</td><td><span class="chip ${p.turno}">${p.turno}</span></td>
      <td class="num">${p.enfP||0}/${p.enfPl||0}</td><td class="num">${ENF.reduce((a,e)=>a+N(p.e?.[e.k]),0)}</td>
      <td><button class="btn gh sm" data-pe="${p.id}" data-pf="${p.fecha}">Editar</button>
          <button class="btn dg sm" data-px="${p.id}" data-pf2="${p.fecha}">×</button></td></tr>`).join('')}
    </tbody></table>`:'<p class="hint">Sin partes cargados.</p>'}</div></div>
   <div class="card"><h2>Controles del carro</h2><div class="tblwrap">${K.length?`<table><thead><tr>
     <th>Fecha</th><th>Turno</th><th>Precinto</th><th>Desfib.</th><th>Por vencer</th><th></th></tr></thead><tbody>
     ${K.map(k=>`<tr><td class="num">${esd(k.fecha)}</td><td><span class="chip ${k.turno}">${k.turno}</span></td>
       <td>${ok(k.precinto)}</td><td>${ok(k.desf)}</td><td class="num">${N(k.venc)||'—'}</td>
       <td><button class="btn gh sm" data-ke="${k.id}" data-kf="${k.fecha}">Editar</button>
           <button class="btn dg sm" data-kx="${k.id}" data-kf2="${k.fecha}">×</button></td></tr>`).join('')}
     </tbody></table>`:'<p class="hint">Sin controles.</p>'}</div></div>
   <div class="card"><h2>Eventos</h2><div class="tblwrap">${V.length?`<table><thead><tr>
     <th>Fecha</th><th>Tipo</th><th>Grav.</th><th>Estado</th><th></th></tr></thead><tbody>
     ${V.map(v=>`<tr><td class="num">${esd(v.fecha)}</td><td>${esc((EVT.find(x=>x.k===v.tipo)||{}).n||v.tipo)}</td>
       <td><span class="chip ${N(v.grav)>=4?'bad':N(v.grav)>=3?'wa':''}">${v.grav}</span></td>
       <td><span class="chip ${v.est==='cerrado'?'ok':'wa'}">${v.est}</span></td>
       <td><button class="btn gh sm" data-ve="${v.id}" data-vf="${v.fecha}">Editar</button>
           <button class="btn dg sm" data-vx="${v.id}" data-vf2="${v.fecha}">×</button></td></tr>`).join('')}
     </tbody></table>`:'<p class="hint">Sin eventos.</p>'}</div></div>`;
}
function bindHist(){
  document.querySelectorAll('[data-pe]').forEach(b=>b.onclick=()=>{
    editP=(B.partes[ym(b.dataset.pf)]||[]).find(x=>x.id===b.dataset.pe);sub='parte';vCargar()});
  document.querySelectorAll('[data-ve]').forEach(b=>b.onclick=()=>{
    editE=(B.eventos[ym(b.dataset.vf)]||[]).find(x=>x.id===b.dataset.ve);sub='evento';vCargar()});
  document.querySelectorAll('[data-ke]').forEach(b=>b.onclick=()=>{
    editK=(B.checks[ym(b.dataset.kf)]||[]).find(x=>x.id===b.dataset.ke);sub='carro';vCargar()});
  document.querySelectorAll('[data-px]').forEach(b=>b.onclick=()=>{
    if(!confirm('¿Borrar este parte?'))return;
    borrarItem('partes',b.dataset.px,b.dataset.pf2);vCargar();vPanel();toast('Parte borrado')});
  document.querySelectorAll('[data-vx]').forEach(b=>b.onclick=()=>{
    if(!confirm('¿Borrar este evento?'))return;
    borrarItem('eventos',b.dataset.vx,b.dataset.vf2);vCargar();vPanel();toast('Evento borrado')});
  document.querySelectorAll('[data-kx]').forEach(b=>b.onclick=()=>{
    if(!confirm('¿Borrar este control?'))return;
    borrarItem('checks',b.dataset.kx,b.dataset.kf2);vCargar();vPanel();toast('Control borrado')});
}

/* =============================================================
   VISTA · EQUIPOS
   ============================================================= */
let editEq=null, editSt=null;
function vEquipos(){
  const E=aggEq();
  // formulario de edición de un equipo
  const formEq=editEq!==null?(()=>{const e=editEq.id?editEq:{tipo:EQTIPO[0],id2:'',ubic:'',est:'op',desde:iso(new Date()),pm:''};
    return `<div class="card" style="border-color:var(--t4)"><h2>${editEq.id?'Editar equipo':'Nuevo equipo'}</h2>
     <div class="grid g2">
       <div class="field"><label>Tipo</label><select id="eq_tipo">${EQTIPO.map(t=>`<option ${e.tipo===t?'selected':''}>${t}</option>`).join('')}</select></div>
       <div class="field"><label>Identificación (patrimonio o nombre)</label><input id="eq_id2" value="${esc(e.id2)}" style="font-family:var(--body)"></div>
       <div class="field"><label>Ubicación (box, sector)</label><input id="eq_ubic" value="${esc(e.ubic)}" style="font-family:var(--body)"></div>
       <div class="field"><label>Estado</label><select id="eq_est">${EQEST.map(s=>`<option value="${s.k}" ${e.est===s.k?'selected':''}>${s.n}</option>`).join('')}</select></div>
       <div class="field"><label>Próximo mantenimiento</label><input type="date" id="eq_pm" value="${e.pm||''}"></div>
     </div>
     <div class="actions"><button class="btn sm" id="eqSave">Guardar</button>
       <button class="btn gh sm" id="eqCancel">Cancelar</button></div></div>`})():'';
  // formulario de edición de un ítem de stock
  const formSt=editSt!==null?(()=>{const s=editSt.id?editSt:{n:'',cant:0,min:2};
    return `<div class="card" style="border-color:var(--t4)"><h2>${editSt.id?'Editar ítem':'Nuevo ítem'}</h2>
     <div class="grid g3">
       <div class="field"><label>Ítem</label><input id="st_n" value="${esc(s.n)}" style="font-family:var(--body)"></div>
       <div class="field"><label>Cantidad actual</label><input type="number" id="st_cant" value="${N(s.cant)}"></div>
       <div class="field"><label>Cantidad mínima</label><input type="number" id="st_min" value="${N(s.min)}"></div>
     </div>
     <div class="actions"><button class="btn sm" id="stSave">Guardar</button>
       <button class="btn gh sm" id="stCancel">Cancelar</button></div></div>`})():'';

  $('v-equipos').innerHTML=`<div class="grid g2" style="margin-top:12px">
    ${kpi('Operatividad',f1(E.pOper),'%',`${E.op} de ${E.tot}`,est(E.pOper,S.cfg.oper,true))}
    ${kpi('En reparación',E.rep||0,'','Esperando bioingeniería',(E.rep||0)?'warn':'hi')}
    ${kpi('Fuera de servicio',E.fs||0,'','Sin fecha de retorno',(E.fs||0)?'bad':'hi')}
    ${kpi('Mantenimiento vencido',E.pmVenc,'','Preventivo fuera de fecha',E.pmVenc?'warn':'hi')}</div>
   ${formEq}
   <div class="card"><h2>Inventario</h2>
    ${S.equipos.length?`<div class="tblwrap"><table><thead><tr><th>Tipo</th><th>Id.</th><th>Ubic.</th><th>Estado</th><th>Parado</th><th>Mant.</th><th></th></tr></thead>
     <tbody>${S.equipos.map(e=>`<tr><td>${esc(e.tipo)}</td><td>${esc(e.id2)||'—'}</td><td>${esc(e.ubic)||'—'}</td>
      <td><select data-eq="${e.id}" style="padding:6px 7px;font-size:13px">${EQEST.map(s=>
        `<option value="${s.k}" ${e.est===s.k?'selected':''}>${s.n}</option>`).join('')}</select></td>
      <td class="num">${e.est!=='op'&&e.desde?Math.floor((new Date(iso(new Date()))-new Date(e.desde))/864e5)+' d':'—'}</td>
      <td class="num">${e.pm?`<span class="chip ${e.pm<iso(new Date())?'bad':'ok'}">${esd(e.pm)}</span>`:'—'}</td>
      <td><button class="btn gh sm" data-eqe="${e.id}">Editar</button>
          <button class="btn dg sm" data-eqx="${e.id}">×</button></td></tr>`).join('')}</tbody></table></div>`
     :'<p class="hint">Cargá las bombas, respiradores y monitores. Después solo vas a cambiar el estado.</p>'}
    <div class="actions"><button class="btn sm" id="eqAdd">Agregar equipo</button></div></div>
   ${formSt}
   <div class="card"><h2>Circuitos y descartables</h2>
    ${S.stock.length?`<div class="tblwrap"><table><thead><tr><th>Ítem</th><th>Cant.</th><th>Mín.</th><th>Estado</th><th></th></tr></thead>
     <tbody>${S.stock.map(s=>`<tr><td>${esc(s.n)}</td>
      <td><input type="number" data-st="${s.id}" value="${N(s.cant)}" style="width:78px;padding:6px 7px;font-size:14px"></td>
      <td class="num">${N(s.min)}</td>
      <td>${N(s.cant)<N(s.min)?'<span class="chip bad">Bajo</span>':'<span class="chip ok">OK</span>'}</td>
      <td><button class="btn gh sm" data-ste="${s.id}">Editar</button>
          <button class="btn dg sm" data-stx="${s.id}">×</button></td></tr>`).join('')}</tbody></table></div>`
     :'<p class="hint">Circuitos de respirador, tubuladuras, sets de bomba. Definí un mínimo y el panel te avisa.</p>'}
    <div class="actions"><button class="btn sm" id="stAdd">Agregar ítem</button></div></div>`;

  // cambiar estado rápido desde la tabla
  document.querySelectorAll('[data-eq]').forEach(s=>s.onchange=()=>{
    const e=S.equipos.find(x=>x.id===s.dataset.eq),hoy=iso(new Date());
    if(e.est!=='op'&&s.value==='op'&&e.desde){e.hist=e.hist||[];
      e.hist.push({d:Math.max(0,Math.round((new Date(hoy)-new Date(e.desde))/864e5))})}
    e.est=s.value;e.desde=hoy;guardarBase();vEquipos();vPanel();toast(EQEST.find(x=>x.k===s.value).n)});
  // editar equipo (formulario completo)
  document.querySelectorAll('[data-eqe]').forEach(b=>b.onclick=()=>{
    editEq=S.equipos.find(x=>x.id===b.dataset.eqe);editSt=null;vEquipos();window.scrollTo({top:0,behavior:'smooth'})});
  document.querySelectorAll('[data-eqx]').forEach(b=>b.onclick=()=>{
    if(!confirm('¿Borrar el equipo?'))return;
    S.equipos=S.equipos.filter(x=>x.id!==b.dataset.eqx);guardarBase();vEquipos();vPanel()});
  $('eqAdd').onclick=()=>{editEq={};editSt=null;vEquipos();window.scrollTo({top:0,behavior:'smooth'})};
  if($('eqSave'))$('eqSave').onclick=()=>{
    const e=editEq.id?editEq:{id:'e'+Date.now(),hist:[],desde:iso(new Date())};
    e.tipo=$('eq_tipo').value;e.id2=$('eq_id2').value.trim();e.ubic=$('eq_ubic').value.trim();
    // si cambió a operativo, cierro el período parado
    if(e.est&&e.est!=='op'&&$('eq_est').value==='op'&&e.desde){e.hist=e.hist||[];
      e.hist.push({d:Math.max(0,Math.round((new Date(iso(new Date()))-new Date(e.desde))/864e5))})}
    if(e.est!==$('eq_est').value)e.desde=iso(new Date());
    e.est=$('eq_est').value;e.pm=$('eq_pm').value;
    if(!editEq.id)S.equipos.push(e);
    editEq=null;guardarBase();vEquipos();vPanel();toast('Equipo guardado')};
  if($('eqCancel'))$('eqCancel').onclick=()=>{editEq=null;vEquipos()};

  // stock: editar cantidad rápido
  document.querySelectorAll('[data-st]').forEach(i=>i.onchange=()=>{
    S.stock.find(x=>x.id===i.dataset.st).cant=N(i.value);guardarBase();vEquipos();vPanel()});
  document.querySelectorAll('[data-ste]').forEach(b=>b.onclick=()=>{
    editSt=S.stock.find(x=>x.id===b.dataset.ste);editEq=null;vEquipos();window.scrollTo({top:0,behavior:'smooth'})});
  document.querySelectorAll('[data-stx]').forEach(b=>b.onclick=()=>{
    if(!confirm('¿Borrar el ítem?'))return;
    S.stock=S.stock.filter(x=>x.id!==b.dataset.stx);guardarBase();vEquipos()});
  $('stAdd').onclick=()=>{editSt={};editEq=null;vEquipos();window.scrollTo({top:0,behavior:'smooth'})};
  if($('stSave'))$('stSave').onclick=()=>{
    const n=$('st_n').value.trim();if(!n){toast('Poné un nombre',1);return}
    const s=editSt.id?editSt:{id:'s'+Date.now()};
    s.n=n;s.cant=N($('st_cant').value);s.min=N($('st_min').value);
    if(!editSt.id)S.stock.push(s);
    editSt=null;guardarBase();vEquipos();vPanel();toast('Ítem guardado')};
  if($('stCancel'))$('stCancel').onclick=()=>{editSt=null;vEquipos()};
}

/* =============================================================
   VISTA · IMPORTAR
   ============================================================= */
function vImportar(){
  $('v-importar').innerHTML=`<div class="notice" style="margin-top:12px">
     <b>El archivo no sale de esta computadora.</b> Se lee acá, y a la nube sube únicamente el resumen del día:
     cuántos por hora, por destino y la distribución de esperas. Ninguna fila individual se envía.</div>
   <div class="step" id="st1"><h3><span>01</span>Elegí el archivo</h3>
     <div class="drop" id="drop" tabindex="0" role="button"><b>Tocá para buscarlo</b>
       <span class="hint">.xlsx, .xls o .csv · también podés arrastrarlo</span></div>
     <input type="file" id="file" accept=".xlsx,.xls,.csv,.txt" class="hidden">
     <div id="fileInfo" class="hint" style="margin-top:8px"></div></div>
   <div class="step hidden" id="st2"><h3><span>02</span>Qué columna es cada cosa</h3>
     <p class="hint" style="margin-top:-4px">Se detecta solo y queda guardado.</p><div id="mapBox"></div></div>
   <div class="step hidden" id="st3"><h3><span>03</span>Revisá y confirmá</h3>
     <div id="prevBox"></div>
     <div class="actions"><button class="btn" id="doImp">Guardar el resumen</button>
       <button class="btn gh sm" id="cancelImp">Cancelar</button></div></div>
   <div class="card"><h2>Días con datos</h2><div id="diasBox"></div></div>`;
  const D=items('dias',meses(6)).sort((a,b)=>b.f.localeCompare(a.f)).slice(0,40);
  $('diasBox').innerHTML=D.length?`<div class="tblwrap"><table><thead><tr><th>Fecha</th><th>Atenciones</th>
    <th>Espera media</th><th>Internados</th><th></th></tr></thead><tbody>
    ${D.map(d=>`<tr><td class="num">${esd(d.f)}</td><td class="num">${d.n}</td>
      <td class="num">${d.espN?Math.round(d.espSum/d.espN)+"'":'—'}</td>
      <td class="num">${(d.de?.intern||0)+(d.de?.uti||0)}</td>
      <td><button class="btn dg sm" data-dx="${d.f}">×</button></td></tr>`).join('')}</tbody></table></div>`
    :'<p class="hint">Todavía no importaste ningún archivo.</p>';
  document.querySelectorAll('[data-dx]').forEach(b=>b.onclick=()=>{
    if(!confirm('¿Borrar el resumen de ese día?'))return;
    borrarItem('dias',b.dataset.dx,b.dataset.dx);vImportar();vPanel()});
  const drop=$('drop'),file=$('file');
  drop.onclick=()=>file.click();
  drop.ondragover=e=>{e.preventDefault();drop.classList.add('over')};
  drop.ondragleave=()=>drop.classList.remove('over');
  drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over');if(e.dataTransfer.files[0])leer(e.dataTransfer.files[0])};
  file.onchange=e=>{if(e.target.files[0])leer(e.target.files[0])};
  $('cancelImp').onclick=()=>vImportar();
  $('doImp').onclick=()=>{
    const res=resumir(filas());
    res.forEach(d=>guardarItem('dias',d));
    toast(`${res.length} día(s) guardados`);vImportar();vPanel()};
}
async function cargarXLSX(){
  if(window.XLSX)return true;
  return new Promise(r=>{const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload=()=>r(true);s.onerror=()=>r(false);document.head.appendChild(s)});
}
async function leer(f){
  const csv=/\.csv|\.txt$/i.test(f.name);
  if(!csv&&!(await cargarXLSX())){toast('Sin conexión no se leen .xlsx — guardalo como CSV',1);return}
  const fr=new FileReader();
  fr.onload=e=>{
    try{
      let headers,rows;
      if(csv){const a=parseCSV(e.target.result);headers=a[0].map(x=>String(x).trim());rows=a.slice(1)}
      else{const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array',cellDates:true});
        const a=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:''});
        let hi=0;for(let i=0;i<Math.min(8,a.length);i++){
          if(a[i].filter(x=>String(x).trim().length>1).length>=3){hi=i;break}}
        headers=a[hi].map(x=>String(x).trim());rows=a.slice(hi+1).filter(r=>r.some(x=>String(x).trim()!==''))}
      IMP={headers,rows,name:f.name};
      $('fileInfo').innerHTML=`<b style="color:var(--ink)">${esc(f.name)}</b> · ${rows.length} filas`;
      $('st1').classList.add('done');
      // Si no hay mapeo guardado, o el guardado apunta a columnas que este archivo no tiene
      // (el sistema exporta con nombres distintos según el día), lo recalculo automáticamente.
      const m=S.cfg.map;
      const sirve=m&&Object.keys(m).length&&Object.values(m).every(i=>i<headers.length);
      const fechaOk=sirve&&m.fecha!=null&&/ingreso|fec|fch|d[ií]a|fecha/i.test(headers[m.fecha]||'');
      if(!fechaOk)S.cfg.map=autoMap(headers);
      pintarMap();
    }catch(err){console.error(err);toast('No se pudo leer el archivo',1)}};
  if(csv)fr.readAsText(f,'utf-8');else fr.readAsArrayBuffer(f);
}
function pintarMap(){
  const m=S.cfg.map||{};
  $('mapBox').innerHTML=CAMPOS.map(c=>`<div class="maprow"><span>${c.n}${c.req?' *':''}</span>
    <select data-mk="${c.k}"><option value="">— sin columna —</option>
    ${IMP.headers.map((h,i)=>`<option value="${i}" ${m[c.k]==i?'selected':''}>${esc(h)||'col '+(i+1)}</option>`).join('')}
    </select></div>`).join('');
  $('mapBox').querySelectorAll('select').forEach(s=>s.onchange=()=>{
    if(s.value==='')delete S.cfg.map[s.dataset.mk];else S.cfg.map[s.dataset.mk]=+s.value;
    guardarBase();previa()});
  $('st2').classList.remove('hidden');previa();
}
function previa(){
  if(!IMP||S.cfg.map?.fecha==null){$('st3').classList.add('hidden');return}
  const rows=filas();
  if(!rows.length){$('prevBox').innerHTML='<p class="hint" style="color:var(--t2)">No se leyó ninguna fecha válida.</p>';
    $('st3').classList.remove('hidden');$('doImp').disabled=true;return}
  const res=resumir(rows),esp=rows.map(r=>r.esp).filter(x=>x!=null).sort((a,b)=>a-b);
  const fs=rows.map(r=>r.f).sort();
  const ya=res.filter(d=>(B.dias[ym(d.f)]||[]).some(x=>x.f===d.f)).length;
  $('prevBox').innerHTML=`<div class="sum">
      <div>Filas<b class="num">${rows.length}</b></div>
      <div>Días<b class="num">${res.length}</b></div>
      <div>Período<b class="num" style="font-size:15px">${esd(fs[0])} → ${esd(fs[fs.length-1])}</b></div>
      <div>Espera mediana<b class="num">${esp.length?esp[Math.floor(esp.length/2)]+"'":'—'}</b></div></div>
    ${ya?`<p class="hint" style="color:var(--t3)">${ya} día(s) ya estaban cargados: se reemplazan.</p>`:''}
    <p class="hint">Sube a la nube el resumen de ${res.length} día(s). Las ${rows.length} filas quedan acá.</p>`;
  $('st3').classList.remove('hidden');$('st2').classList.add('done');$('doImp').disabled=false;
}

/* =============================================================
   VISTA · AJUSTES
   ============================================================= */
function vAjustes(){
  const c=S.cfg;
  $('v-ajustes').innerHTML=`<form id="fCfg" style="margin-top:12px">
   <fieldset><legend>Servicio</legend>
     <div class="field"><label>Nombre</label><input type="text" id="c_nombre" value="${esc(c.nombre)}" style="font-family:var(--body)"></div>
     <div class="field"><label>Institución</label><input type="text" id="c_hosp" value="${esc(c.hosp)}" style="font-family:var(--body)"></div>
     <div class="field"><label>Esquema de turnos</label><select id="c_esquema">
       <option value="3" ${c.esquema==3?'selected':''}>Tres de 8 h (M · T · N)</option>
       <option value="2" ${c.esquema==2?'selected':''}>Dos de 12 h (D · N)</option></select></div>
     <div class="grid g3">
       <div class="field"><label>Médicos por turno</label><input type="number" id="c_med" value="${c.med}"></div>
       <div class="field"><label>Enfermería por turno</label><input type="number" id="c_enf" value="${c.enf}"></div>
       <div class="field"><label>Camas de observación</label><input type="number" id="c_camas" value="${c.camas}"></div></div>
   </fieldset>
   <fieldset><legend>Metas</legend><div class="grid g2">
     ${[['recon','Reconsulta 72 h máx. (%)'],['lwbs','Retiro sin atención máx. (%)'],['hm','Higiene de manos mín. (%)'],
        ['cob','Cobertura de dotación mín. (%)'],['pxe','Pacientes por enfermera/o máx.'],['ocup','Ocupación observación máx. (%)'],
        ['oper','Operatividad de equipos mín. (%)']]
       .map(([k,n])=>`<div class="field"><label>${n}</label><input type="number" step="0.1" id="c_${k}" value="${c[k]}"></div>`).join('')}
   </div></fieldset>
   <button type="submit" class="btn wide">Guardar ajustes</button>
   <div class="actions" style="margin-top:12px">
     <button type="button" class="btn gh sm" id="expCsv">Exportar indicadores</button>
     <button type="button" class="btn gh sm" id="resetMap">Olvidar el mapeo del Excel</button>
     <button type="button" class="btn dg sm" id="salir">Cerrar sesión</button></div>
   <p class="hint" style="margin-top:14px">Cuenta: ${esc(auth.currentUser?.email||'—')}<br>
     Los datos viven en tu Firestore. Nada se borra al cerrar sesión.</p></form>`;
  $('fCfg').onsubmit=e=>{e.preventDefault();
    Object.assign(S.cfg,{nombre:$('c_nombre').value.trim()||CFG_DEF.nombre,hosp:$('c_hosp').value.trim(),
      esquema:+$('c_esquema').value,med:N($('c_med').value),enf:N($('c_enf').value),camas:N($('c_camas').value)});
    ['recon','lwbs','hm','cob','pxe','ocup','oper'].forEach(k=>S.cfg[k]=N($('c_'+k).value));
    guardarBase();cabecera();vPanel();toast('Ajustes guardados')};
  $('resetMap').onclick=()=>{S.cfg.map=null;S.cfg.vmapT={};S.cfg.vmapD={};guardarBase();toast('Mapeo olvidado')};
  $('salir').onclick=()=>signOut(auth);
  $('expCsv').onclick=exportar;
}
function exportar(){
  const A=aggDias(range),P=aggPartes(range),E=aggEq(),C=aggCarro(range),V=aggEv(range,A.n);
  const r=[['indicador','valor','unidad','periodo_dias']];
  const add=(n,v,u)=>r.push([n,v==null||isNaN(v)?'':String(Math.round(v*10)/10).replace('.',','),u||'',range]);
  add('Atenciones',A.n);add('Atenciones por dia',A.porDia);add('Urgencia real',A.pUrg,'%');
  add('Internacion',A.pIntern,'%');add('Retiro sin atencion',A.pLwbs,'%');
  add('Espera mediana',A.espMed,'min');add('Espera p90',A.espP90,'min');add('Atendidos en 15 min',A.pEsp15,'%');
  add('Hora pico',A.picoHora,'h');add('Practicas de enfermeria',P.procs);
  add('Pacientes por enfermero',P.enfP?A.n/P.enfP:null);add('Cobertura enfermeria',P.cobEnf,'%');
  add('Cobertura medica',P.cobMed,'%');add('Ausencias sin reemplazo',P.aus);add('Horas extra',P.hs,'h');
  add('Ocupacion observacion',P.ocup,'%');add('Higiene de manos',P.pHM,'%');
  add('Operatividad de equipos',E.pOper,'%');add('Dias-equipo perdidos',E.diasFS,'dias');
  add('Adherencia control carro',C.adh,'%');add('Controles con hallazgo',C.pHall,'%');
  add('Eventos criticos',V.n);add('Eventos por 1000 atenciones',V.tasa);add('Eventos cerrados',V.pCerr,'%');
  const b=new Blob(['\uFEFF'+r.map(x=>x.join(';')).join('\n')],{type:'text/csv;charset=utf-8'});
  const u=URL.createObjectURL(b),a=document.createElement('a');
  a.href=u;a.download='indicadores-guardia.csv';a.click();URL.revokeObjectURL(u);
}

/* =============================================================
   NAVEGACIÓN
   ============================================================= */
function go(v){
  vista=v;sub=null;
  document.querySelectorAll('.tab').forEach(b=>b.setAttribute('aria-selected',b.dataset.v===v));
  ['panel','cargar','equipos','importar','ajustes'].forEach(x=>$('v-'+x).classList.toggle('hidden',x!==v));
  if(v==='panel')vPanel();if(v==='cargar')vCargar();if(v==='equipos')vEquipos();
  if(v==='importar')vImportar();if(v==='ajustes')vAjustes();
  window.scrollTo({top:0,behavior:'smooth'});
}
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>go(b.dataset.v));
function cabecera(){
  $('svcName').textContent=S.cfg.nombre;
  $('svcSub').textContent=S.cfg.hosp||'Consola de gestión';
  const p=pendientes().length,C=aggCarro(7);
  const alerta=p>0||C.porCarro.some(x=>x.dias==null||x.dias>1);
  $('dotCargar').classList.toggle('hidden',!alerta);
}
window.addEventListener('online',()=>setSync('','sincronizado'));
window.addEventListener('offline',()=>setSync('off','sin conexión'));

/* =============================================================
   ARRANQUE
   ============================================================= */
$('btnLogin').onclick=async()=>{
  try{await signInWithPopup(auth,new GoogleAuthProvider())}
  catch(e){console.warn(e);try{await signInWithRedirect(auth,new GoogleAuthProvider())}
    catch(e2){$('loginMsg').textContent='No se pudo abrir el inicio de sesión: '+e2.code}}
};
$('avatar').onclick=()=>{if(confirm('¿Cerrar sesión?'))signOut(auth)};
getRedirectResult(auth).catch(()=>{});
onAuthStateChanged(auth,async u=>{
  if(!u){$('login').classList.remove('hidden');UID=null;return}
  UID=u.uid;$('login').classList.add('hidden');
  $('avatar').textContent=(u.displayName||u.email||'?').trim().charAt(0).toUpperCase();
  cacheLeer();cabecera();go('panel');
  await cargarTodo();cabecera();go(vista);
});
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
