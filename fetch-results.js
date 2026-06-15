// fetch-results.js — run by GitHub Actions on a schedule.
// Pulls World Cup results from ESPN's public feed and writes results.json:
//   { group:"<72 W/D/L digits>", scores:[...72], stages:"<48 digits>", updated:ISO }
// The web page reads results.json (same-origin) and fills the leaderboard + fixtures automatically.
// Node 20+ (built-in fetch). No API key required.

const fs = require("fs");

// teams in the SAME order the web page uses (drives the 48-char stages string)
const TEAM_ORDER = ["France","Spain","Argentina","England","Portugal","Brazil","Netherlands","Morocco",
  "Belgium","Germany","Croatia","Colombia","Senegal","Mexico","United States","Uruguay","Japan","Switzerland",
  "Iran","Türkiye","Ecuador","Austria","South Korea","Australia","Canada","Norway","Egypt","Algeria","Sweden",
  "Paraguay","Ivory Coast","Czechia","Scotland","Tunisia","Panama","Qatar","DR Congo","Iraq","Uzbekistan",
  "Saudi Arabia","South Africa","Jordan","Cape Verde","Bosnia & H.","Ghana","Haiti","Curaçao","New Zealand"];
const TIDX = {}; TEAM_ORDER.forEach((n,i)=>TIDX[n]=i);

const GROUPS = {
  A:["Mexico","South Africa","South Korea","Czechia"], B:["Canada","Switzerland","Qatar","Bosnia & H."],
  C:["Brazil","Morocco","Haiti","Scotland"], D:["United States","Paraguay","Australia","Türkiye"],
  E:["Germany","Curaçao","Ivory Coast","Ecuador"], F:["Netherlands","Japan","Sweden","Tunisia"],
  G:["Belgium","Egypt","Iran","New Zealand"], H:["Spain","Cape Verde","Saudi Arabia","Uruguay"],
  I:["France","Senegal","Iraq","Norway"], J:["Argentina","Algeria","Austria","Jordan"],
  K:["Portugal","DR Congo","Uzbekistan","Colombia"], L:["England","Croatia","Ghana","Panama"]
};

const MATCHES = [];
for (const [g,t] of Object.entries(GROUPS))
  for (let i=0;i<t.length;i++) for (let j=i+1;j<t.length;j++) MATCHES.push({g,a:t[i],b:t[j]});
const PAIR2K = {};
MATCHES.forEach((m,k)=>{ PAIR2K[m.a+"|"+m.b]=k; PAIR2K[m.b+"|"+m.a]=k; });

const ALIAS = { usa:"United States", unitedstates:"United States", korearepublic:"South Korea",
  korea:"South Korea", czechrepublic:"Czechia", turkey:"Türkiye", turkiye:"Türkiye",
  cotedivoire:"Ivory Coast", ivorycoast:"Ivory Coast", congodr:"DR Congo", drcongo:"DR Congo",
  democraticrepublicofthecongo:"DR Congo", bosniaandherzegovina:"Bosnia & H.",
  bosniaherzegovina:"Bosnia & H.", bosnia:"Bosnia & H.", caboverde:"Cape Verde",
  capeverde:"Cape Verde", curacao:"Curaçao" };
const norm = s => (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
const NAME2OURS = {};
TEAM_ORDER.forEach(n => NAME2OURS[norm(n)] = n);
Object.entries(ALIAS).forEach(([k,v]) => NAME2OURS[norm(k)] = v);
const findTeam = n => NAME2OURS[norm(n)] || null;

const ROUND_BASE = { R32:1, R16:2, QF:3, SF:4, F:5 };
const ROUND_LABEL = { R32:"Round of 32", R16:"Round of 16", QF:"Quarter-final", SF:"Semi-final", F:"Final" };
function koRound(d){
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const md = (m,day) => Date.UTC(2026, m-1, day);
  if (t >= md(7,19)) return "F";
  if (t >= md(7,18)) return null;   // 3rd-place play-off
  if (t >= md(7,14)) return "SF";
  if (t >= md(7,9))  return "QF";
  if (t >= md(7,4))  return "R16";
  if (t >= md(6,28)) return "R32";
  return null;
}

const LEAGUE = "fifa.world";
const base = `https://site.api.espn.com/apis/site/v2/sports/soccer/${LEAGUE}/scoreboard?dates=`;

async function run(){
  const gres   = new Array(MATCHES.length).fill(0);
  const scores = new Array(MATCHES.length).fill("");
  const stages = new Array(TEAM_ORDER.length).fill(0);
  const koMap  = {};
  let   nextUp = null;
  const redCandidates = [];
  const bump = (name,val) => { const i=TIDX[name]; if(i!==undefined && val>stages[i]) stages[i]=val; };
  const spotWhere = (a,b,d) => {
    if(PAIR2K[a+"|"+b]!==undefined) return "Grp " + MATCHES[PAIR2K[a+"|"+b]].g;
    const r = d ? koRound(d) : null;
    return r ? ROUND_LABEL[r] : "World Cup";
  };

  const start = new Date(Date.UTC(2026,5,11));
  const today = new Date();
  const end   = new Date(today.getTime() + 6*864e5);
  const dates = [];
  for (let d=new Date(start); d<=end; d.setUTCDate(d.getUTCDate()+1))
    dates.push(`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,"0")}${String(d.getUTCDate()).padStart(2,"0")}`);

  for (const dt of dates){
    try{
      const r = await fetch(base + dt);
      if(!r.ok) continue;
      const j = await r.json();
      for (const ev of (j.events||[])){
        const comp = ev.competitions && ev.competitions[0]; if(!comp) continue;
        const cs = comp.competitors; if(!cs || cs.length!==2) continue;
        const stype = ev.status && ev.status.type ? ev.status.type : {};
        const completed = stype.completed;
        const n0 = findTeam(cs[0].team && (cs[0].team.displayName||cs[0].team.name));
        const n1 = findTeam(cs[1].team && (cs[1].team.displayName||cs[1].team.name));
        if(!n0 || !n1) continue;
        const evDate = ev.date ? new Date(ev.date) : null;
        if((stype.state==="post"||stype.state==="in") && ev.id && evDate) redCandidates.push({id:ev.id, date:evDate});
        const k = PAIR2K[n0 + "|" + n1];
        const s0 = parseInt(cs[0].score,10), s1 = parseInt(cs[1].score,10);
        const winnerName = (!isNaN(s0)&&!isNaN(s1)) ? (s0>s1?n0 : s1>s0?n1 : null)
                                                    : (cs[0].winner?n0 : cs[1].winner?n1 : null);

        if(stype.state==="pre" && evDate && evDate.getTime()>=Date.now()){
          if(!nextUp || evDate < nextUp._d) nextUp = { a:n0, b:n1, date:ev.date, where:spotWhere(n0,n1,evDate), _d:evDate };
        }

        if (k !== undefined){          // group match
          if(!completed) continue;
          gres[k] = winnerName===null ? 2 : (winnerName===MATCHES[k].a ? 1 : 3);
          if(!isNaN(s0)&&!isNaN(s1)) scores[k] = (n0===MATCHES[k].a) ? `${s0}-${s1}` : `${s1}-${s0}`;
        } else if (evDate){            // knockout match — round from date
          const round = koRound(evDate); if(!round) continue;
          const b = ROUND_BASE[round];
          bump(n0,b); bump(n1,b);                       // reached this round
          const key = [n0,n1].sort().join("|") + "|" + round;
          koMap[key] = { a:n0, b:n1, round, sa:isNaN(s0)?null:s0, sb:isNaN(s1)?null:s1, done:!!completed };
          if(completed && winnerName) bump(winnerName, round==="F" ? 6 : b+1);
        }
      }
    }catch(e){ /* skip a bad day */ }
  }

  // ---- first red card of the tournament (per-match summary endpoint) ----
  const keTeamId = ke => {
    if(!ke.team) return null;
    if(ke.team.id!=null) return String(ke.team.id);
    if(ke.team.$ref){ const m=String(ke.team.$ref).match(/teams\/(\d+)/); return m?m[1]:null; }
    return null;
  };
  const clockSecs = ke => {
    if(ke.clock && ke.clock.value!=null) return ke.clock.value;
    const dv=(ke.clock&&ke.clock.displayValue)||""; const m=dv.match(/(\d+)/);
    return m?parseInt(m[1],10)*60:0;
  };
  async function matchFirstRed(id, dateObj){
    try{
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${LEAGUE}/summary?event=${id}`);
      if(!r.ok) return null;
      const j = await r.json();
      const id2name={};
      const comps=(j.header&&j.header.competitions&&j.header.competitions[0]&&j.header.competitions[0].competitors)||[];
      comps.forEach(c=>{ if(c.team){ const nm=findTeam(c.team.displayName||c.team.name||c.team.shortDisplayName); if(nm) id2name[String(c.team.id)]=nm; }});
      let best=null;
      for(const ke of (j.keyEvents||[])){
        const txt=((ke.type&&(ke.type.text||ke.type.name))||"").toLowerCase();
        if(!txt.includes("red")) continue;
        const tid=keTeamId(ke); const team=tid?id2name[tid]:null; if(!team) continue;
        const secs=clockSecs(ke);
        const minute=(ke.clock&&ke.clock.displayValue)||(Math.round(secs/60)+"'");
        if(best===null || secs<best.secs) best={team, minute, secs};
      }
      if(!best) return null;
      return { team:best.team, minute:best.minute, when:dateObj.getTime()+best.secs*1000 };
    }catch(e){ return null; }
  }
  let firstRed=null;
  redCandidates.sort((a,b)=>a.date-b.date);
  let rb=24;                                   // cap summary fetches
  for(const c of redCandidates){
    if(rb--<=0) break;
    const red=await matchFirstRed(c.id, c.date);
    if(red){ firstRed={team:red.team, minute:red.minute}; break; }  // earliest match with a red card
  }

  const next = nextUp ? { a:nextUp.a, b:nextUp.b, date:nextUp.date, where:nextUp.where } : null;
  const out = { group: gres.join(""), scores, stages: stages.join(""), ko: Object.values(koMap), next, firstRed, updated: new Date().toISOString() };
  fs.writeFileSync("results.json", JSON.stringify(out));
  console.log(`Wrote results.json — ${gres.filter(x=>x).length}/${MATCHES.length} group games, `
    + `${Object.keys(koMap).length} knockout games, ${stages.filter(x=>x).length} teams with a stage`
    + (next ? `, next: ${next.a} v ${next.b}` : "")
    + (firstRed ? `, first red: ${firstRed.team} ${firstRed.minute}` : "") + ".");
}

run();
