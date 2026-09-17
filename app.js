const C = window.APP_CONFIG;  if (   !C ||   !C.SUPABASE_URL ||   !C.SUPABASE_KEY ||   C.SUPABASE_URL.includes('PASTE_') ||   C.SUPABASE_KEY.includes('PASTE_') ) {   alert('Supabase is not configured correctly. Check config.js.'); }  const sb = supabase.createClient(   C.SUPABASE_URL,   C.SUPABASE_KEY );let section='dashboard',entries=[],user=null;const sections=[['dashboard','⌂ Dashboard'],['plan','⌁ Future Plans'],['discussion','◌ Discussions'],['game','♟ Couple Games'],['decision','✓ Decisions'],['memory','◇ Memories & Photos'],['bucket','☆ Bucket List'],['date','◷ Important Dates'],['letter','✉ Letters'],['journal','☷ Shared Journal'],['dateidea','♡ Date Ideas']];
function toast(x){let t=document.querySelector('#toast');t.textContent=x;t.style.display='block';setTimeout(()=>t.style.display='none',2500)}
async function signup(){let {error}=await sb.auth.signUp({email:email.value,password:password.value});toast(error?error.message:'Account created. Check your email if confirmation is enabled.');}
async function async function login() {
  const emailValue = document
    .getElementById('email')
    .value
    .trim();

  const passwordValue = document
    .getElementById('password')
    .value;

  if (!emailValue || !passwordValue) {
    toast('Enter both email and password.');
    return;
  }

  try {
    const { data, error } = await sb.auth.signInWithPassword({
      email: emailValue,
      password: passwordValue
    });

    if (error) {
      console.error('Login error:', error);
      toast(error.message);
      return;
    }

    if (!data.session) {
      toast('No login session was created. Confirm your email account.');
      return;
    }

    await init();
  } catch (error) {
    console.error('Unexpected login error:', error);
    toast('Login failed: ' + error.message);
  }
}
async function logout(){await sb.auth.signOut();location.reload()}
async function async function init() {
  try {
    const {
      data: { user },
      error
    } = await sb.auth.getUser();

    if (error) {
      throw error;
    }

    if (!user) {
      toast('No active user session was found.');
      return;
    }

    window.user = user;

    document.getElementById('auth').hidden = true;
    document.getElementById('app').hidden = false;

    document.getElementById('nav').innerHTML = sections
      .map(
        item => `
          <button
            data-s="${item[0]}"
            onclick="show('${item[0]}')"
          >
            ${item[1]}
          </button>
        `
      )
      .join('');

    document.getElementById('fType').innerHTML = sections
      .slice(1)
      .filter(item => !['discussion', 'game'].includes(item[0]))
      .map(
        item => `
          <option value="${item[0]}">
            ${item[1].replace(/^.. /, '')}
          </option>
        `
      )
      .join('');

    await load();
    show('dashboard');
  } catch (error) {
    console.error('Application loading error:', error);
    toast('Dashboard loading error: ' + error.message);
  }
}
async function load(){let {data,error}=await sb.from('entries').select('*').eq('archived',false).order('created_at',{ascending:false});if(error)toast(error.message);entries=data||[]}
function days(a,b){return Math.max(0,Math.ceil((new Date(b)-new Date(a))/864e5))}function esc(s=''){return s.replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function show(s){section=s;document.body.classList.remove('open');pageTitle.textContent=sections.find(x=>x[0]===s)?.[1].replace(/^.. /,'')||s;document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.s===s));if(s==='dashboard')dashboard();else if(s==='discussion'||s==='game')prompts(s);else list(s)}
function dashboard(){let next=days(new Date(),C.NEXT_MEET_DATE),together=days(C.RELATIONSHIP_START,new Date());content.innerHTML=`<section class="hero"><small>WELCOME TO</small><h1>Nick & Judy World</h1><p>Building the next chapter with intention, laughter and barakah.</p></section><section class="stats"><div class="stat"><small>NEXT MEETING</small><b>${next} days</b></div><div class="stat"><small>DAYS TOGETHER</small><b>${together}</b></div><div class="stat"><small>SHARED ITEMS</small><b>${entries.length}</b></div></section><h2>Our current chapter</h2><section class="grid">${cards(entries.filter(e=>e.type==='plan').slice(0,6))}</section>`}
function cards(a){return a.length?a.map(e=>`<article class="card"><span class="pill">${esc(e.category||e.type)}</span><h3>${esc(e.title)}</h3><p>${esc(e.details||'Ready for your notes and checklist.')}</p>${e.target_date?`<small>Target: ${e.target_date}</small>`:''}<div class="actions"><button class="light" onclick="toggleDone('${e.id}',${!e.completed})">${e.completed?'Reopen':'Complete'}</button><button class="light" onclick="archive('${e.id}')">Archive</button></div></article>`).join(''):`<div class="empty">Nothing here yet. Use “Add” to begin.</div>`}
function list(type){let cats=[...new Set(entries.filter(e=>e.type===type).map(e=>e.category).filter(Boolean))];content.innerHTML=`<div class="filters"><button class="active" onclick="filterCards(this,'${type}','')">All</button>${cats.map(c=>`<button onclick="filterCards(this,'${type}','${esc(c)}')">${esc(c)}</button>`).join('')}</div><section class="grid" id="cards">${cards(entries.filter(e=>e.type===type))}</section>`}
function filterCards(btn,t,c){document.querySelectorAll('.filters button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');document.querySelector('#cards').innerHTML=cards(entries.filter(e=>e.type===t&&(!c||e.category===c)))}
async function prompts(kind){let {data}=await sb.from('prompts').select('*').eq('kind',kind).eq(kind==='discussion'?'discussed':'used',false);let cats=[...new Set((data||[]).map(x=>x.category))];content.innerHTML=`<div class="filters">${cats.map((c,i)=>`<button class="${i?'':'active'}" onclick="newPrompt('${kind}','${c.replaceAll("'","\\'")}')">${esc(c)}</button>`).join('')}</div><div id="promptArea" class="card empty">Choose a category to draw a fresh prompt.</div>`;if(cats[0])newPrompt(kind,cats[0])}
async function newPrompt(kind,cat){let {data}=await sb.from('prompts').select('*').eq('kind',kind).eq('category',cat).eq(kind==='discussion'?'discussed':'used',false);if(!data?.length){promptArea.innerHTML='<h3>All prompts in this category are complete 🎉</h3>';return}let p=data[Math.floor(Math.random()*data.length)];promptArea.className='card';promptArea.innerHTML=`<span class="pill">${esc(cat)}</span><p class="prompt">${esc(p.question)}</p>${kind==='discussion'?`<textarea id="conclusion" placeholder="Optional agreed conclusion or note"></textarea><div class="actions"><button onclick="finishPrompt(${p.id},'discussion')">Mark discussed</button><button class="light" onclick="newPrompt('discussion','${cat.replaceAll("'","\\'")}')">Another topic</button></div>`:`<div class="answerbox"><textarea id="a1" placeholder="Nick's answer"></textarea><textarea id="a2" placeholder="Judy's answer"></textarea></div><div class="actions"><button onclick="finishPrompt(${p.id},'game')">Finish & do not repeat</button><button class="light" onclick="newPrompt('game','${cat.replaceAll("'","\\'")}')">Another game</button></div><small>Game answers stay on screen only and are not stored, as requested.</small>`}`}
async function finishPrompt(id,kind){if(kind==='discussion'&&conclusion.value)await sb.from('entries').insert({type:'decision',category:'Discussion conclusion',title:'Agreed conclusion',details:conclusion.value,created_by:user.id,status:'Agreed'});await sb.from('prompts').update(kind==='discussion'?{discussed:true}:{used:true}).eq('id',id);toast('Saved and removed from future draws');prompts(kind)}
function openAdd(){modal.showModal()}
async function saveEntry(e){e.preventDefault();let payload={type:fType.value,title:fTitle.value,category:fCategory.value,details:fDetails.value,status:fStatus.value,target_date:fDate.value||null,budget:fBudget.value||null,created_by:user.id};let {data,error}=await sb.from('entries').insert(payload).select().single();if(error){toast(error.message);return}if(fPhoto.files[0]){let file=fPhoto.files[0],path=`${user.id}/${Date.now()}-${file.name}`;let up=await sb.storage.from('our-universe').upload(path,file);if(!up.error)await sb.from('media').insert({entry_id:data.id,path,uploaded_by:user.id})}modal.close();e.target.reset();await load();show(section);toast('Saved permanently')}
async function toggleDone(id,v){await sb.from('entries').update({completed:v,status:v?'Completed':'In Progress',updated_at:new Date()}).eq('id',id);await load();show(section)}
async function archive(id){if(!confirm('Archive this item? It will not be permanently deleted.'))return;await sb.from('entries').update({archived:true}).eq('id',id);await load();show(section)}
sb.auth.getSession().then(({data})=>data.session?init():null);
