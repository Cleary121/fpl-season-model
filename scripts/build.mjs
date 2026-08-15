// FPL pre-chewer + insights engine
// Runs on GitHub Actions. Fetches the official FPL API, computes compact
// insight tables, and writes docs/briefing.md (+ data.json + snapshot).
// Owner: David Cleary — team "Premier FC" (3509857), league "La liga money" (167948).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const ENTRY = process.env.FPL_ENTRY || '3509857';
const LEAGUE = process.env.FPL_LEAGUE || '167948';
const BASE = 'https://fantasy.premierleague.com/api';
const UA = { headers: { 'User-Agent': 'Mozilla/5.0 (fpl-season-model; personal use)' } };

const j = async (path, optional = false) => {
  try {
    const r = await fetch(BASE + path, UA);
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return await r.json();
  } catch (e) {
    if (optional) return null;
    throw e;
  }
};

// ---------- fetch ----------
const bs = await j('/bootstrap-static/');
const fixtures = await j('/fixtures/?future=1');

const T = Object.fromEntries(bs.teams.map(t => [t.id, t.short_name]));
const POS = ['', 'GKP', 'DEF', 'MID', 'FWD'];
const next = bs.events.find(e => e.is_next) || bs.events.find(e => !e.finished);
const current = bs.events.find(e => e.is_current);
const gwNow = current ? current.id : (next ? next.id - 1 : 0);
const finishedGWs = bs.events.filter(e => e.finished).length;

const picksData = await j(`/entry/${ENTRY}/event/${Math.max(gwNow, 1)}/picks/`, true);
const history = await j(`/entry/${ENTRY}/history/`, true);
const transfers = await j(`/entry/${ENTRY}/transfers/`, true);
const league = await j(`/leagues-classic/${LEAGUE}/standings/`, true);

// ---------- helpers ----------
const n = x => +x || 0;
const money = e => (e.now_cost / 10).toFixed(1);
const mins90 = e => e.minutes / 90;
const per90 = (v, e) => (e.minutes >= 450 ? v / mins90(e) : 0);
const xgiDiff = e => n(e.goals_scored) + n(e.assists) - n(e.expected_goal_involvements);
const playedEnough = e => e.minutes >= Math.max(450, 0.5 * finishedGWs * 90) || finishedGWs < 5;

// Fixture ease per team, next 3 and next 6 (lower FDR = easier)
const teamFx = {};
for (const f of fixtures) {
  if (!f.event || !next || f.event < next.id || f.event >= next.id + 6) continue;
  (teamFx[f.team_h] ??= []).push({ gw: f.event, opp: T[f.team_a], ha: 'H', fdr: f.team_h_difficulty });
  (teamFx[f.team_a] ??= []).push({ gw: f.event, opp: T[f.team_h], ha: 'A', fdr: f.team_a_difficulty });
}
const avgFdr = (tid, count) => {
  const fx = (teamFx[tid] || []).slice(0, count);
  return fx.length ? fx.reduce((s, f) => s + f.fdr, 0) / fx.length : 3.5;
};

// DGW / BGW radar within next 6 GWs
const cnt = {};
for (const f of fixtures) {
  if (!f.event || !next || f.event < next.id || f.event >= next.id + 6) continue;
  cnt[`${f.event}|${f.team_h}`] = (cnt[`${f.event}|${f.team_h}`] || 0) + 1;
  cnt[`${f.event}|${f.team_a}`] = (cnt[`${f.event}|${f.team_a}`] || 0) + 1;
}
const dgws = Object.entries(cnt).filter(([, v]) => v >= 2)
  .map(([k]) => { const [gw, tid] = k.split('|'); return `GW${gw}: ${T[tid]} (double)`; });
const bgws = [];
if (next) for (const t of bs.teams) for (let g = next.id; g < Math.min(next.id + 6, 39); g++) {
  if (bs.events.find(e => e.id === g) && !cnt[`${g}|${t.id}`]) bgws.push(`GW${g}: ${T[t.id]} (blank)`);
}

// Model score v1 (documented in README):
// early season (<5 finished GWs) leans on last-season points; later leans on live form/xGI.
const score = e => {
  const early = finishedGWs < 5;
  const formPart = early ? n(e.points_per_game) * 1.2 : n(e.form) * 1.4;
  const epPart = n(e.ep_next) * 1.6;
  const xgiPart = per90(n(e.expected_goal_involvements), e) * 90 > 0
    ? Math.min(per90(n(e.expected_goal_involvements), e), 1.2) * 4 : 0;
  const defconThresh = e.element_type === 2 ? 10 : 12;
  const defconPart = (e.element_type === 2 || e.element_type === 3)
    ? Math.min(n(e.defensive_contribution_per_90) / defconThresh, 1) * 2 : 0;
  const fxPart = (3.5 - avgFdr(e.team, 3)) * 1.5;
  const availPart = e.status === 'a' ? 0 : -6;
  return +(formPart + epPart + xgiPart + defconPart + fxPart + availPart).toFixed(2);
};

// ---------- snapshot & deltas ----------
const snapPath = 'snapshots/latest.json';
let prev = null;
if (existsSync(snapPath)) { try { prev = JSON.parse(readFileSync(snapPath, 'utf8')); } catch {} }
const myRank = league?.standings?.results?.find(r => String(r.entry) === ENTRY)?.rank ?? null;
const snapNow = {
  savedAt: new Date().toISOString(), gw: next?.id ?? null, myRank,
  players: Object.fromEntries(bs.elements.map(e => [e.id, { p: e.now_cost, f: n(e.form), s: n(e.selected_by_percent), tp: e.total_points }]))
};

// ---------- assemble sections ----------
const L = [];
const H = (s) => L.push(`\n## ${s}\n`);
const row = (arr) => L.push('| ' + arr.join(' | ') + ' |');
const head = (arr) => { row(arr); row(arr.map(() => '---')); };

L.push(`# FPL Pre-Chewed Briefing — Premier FC`);
L.push(`Generated: ${new Date().toISOString()} · Next: **${next ? next.name : 'season over'}** · Deadline: **${next ? next.deadline_time : '-'}** (UTC)`);
L.push(`Entry ${ENTRY} · League "La liga money" (${LEAGUE}) · Finished GWs: ${finishedGWs}`);

H('ALERTS');
const squadIds = picksData?.picks?.map(p => p.element) ?? [];
const squad = bs.elements.filter(e => squadIds.includes(e.id));
const injured = squad.filter(e => e.status !== 'a');
L.push(injured.length
  ? injured.map(e => `- INJURY/DOUBT: **${e.web_name}** (${T[e.team]}) — status ${e.status}, ${e.news || 'no news'} (chance: ${e.chance_of_playing_next_round ?? '?'}%)`).join('\n')
  : '- No injury or availability flags in the squad.');
L.push(dgws.length ? `- DOUBLE GAMEWEEKS AHEAD: ${dgws.join(', ')} — consider Bench Boost / Triple Captain.` : '- No double gameweeks scheduled in the next 6.');
if (bgws.length) L.push(`- BLANKS: ${bgws.join(', ')}`);
if (prev && myRank && prev.myRank) {
  const d = prev.myRank - myRank;
  L.push(`- LA LIGA MONEY: rank ${myRank} (${d > 0 ? 'up ' + d : d < 0 ? 'down ' + (-d) : 'no change'} since last build).`);
}

H('MY SQUAD');
if (squad.length) {
  L.push(`Bank: £${((picksData?.entry_history?.bank ?? 0) / 10).toFixed(1)}m · Value: £${((picksData?.entry_history?.value ?? 0) / 10).toFixed(1)}m · Chips used: ${(history?.chips ?? []).map(c => `${c.name}@GW${c.event}`).join(', ') || 'none'}`);
  head(['Player', 'Team', 'Pos', '£', 'Form', 'ep_next', 'xGI diff', 'DefCon/90', 'Score', 'Next 3', 'Status']);
  for (const e of squad.sort((a, b) => a.element_type - b.element_type)) {
    const fx3 = (teamFx[e.team] || []).slice(0, 3).map(f => `${f.opp}(${f.ha})${f.fdr}`).join(' ');
    row([e.web_name, T[e.team], POS[e.element_type], money(e), e.form, e.ep_next, xgiDiff(e).toFixed(1), e.defensive_contribution_per_90, score(e), fx3, e.status === 'a' ? 'OK' : `${e.status}: ${e.news}`.slice(0, 40)]);
  }
} else {
  L.push('Squad not publicly visible yet (picks appear after the GW1 deadline). Use the baseline squad in the FF 2026 project playbook.');
}
if (transfers?.length && next) {
  const pend = transfers.filter(t => t.event === next.id);
  if (pend.length) L.push(`Pending transfers this GW: ${pend.map(t => `${bs.elements.find(e => e.id === t.element_out)?.web_name}→${bs.elements.find(e => e.id === t.element_in)?.web_name}`).join(', ')}`);
}

H('LA LIGA MONEY (main league)');
const results = league?.standings?.results ?? [];
if (results.length && results.some(r => r.total > 0)) {
  head(['Rank', 'Manager', 'Team', 'Total', 'GW']);
  for (const r of results.slice(0, 10)) row([r.rank, r.player_name, r.entry_name + (String(r.entry) === ENTRY ? ' ⬅ DAVID' : ''), r.total, r.event_total]);
  const me = results.find(r => String(r.entry) === ENTRY);
  if (me) {
    const leader = results[0];
    L.push(`\nDavid: rank ${me.rank} of ${results.length}+ · ${leader.total - me.total} pts behind 1st.`);
    const nearby = results.filter(r => Math.abs(r.rank - me.rank) <= 2 && String(r.entry) !== ENTRY).slice(0, 4);
    for (const r of nearby) {
      const rp = await j(`/entry/${r.entry}/event/${Math.max(gwNow, 1)}/picks/`, true);
      if (rp?.picks) {
        const cap = bs.elements.find(e => e.id === rp.picks.find(p => p.is_captain)?.element);
        const theirs = rp.picks.map(p => p.element);
        const diffs = theirs.filter(id => !squadIds.includes(id)).map(id => bs.elements.find(e => e.id === id)?.web_name).slice(0, 6);
        L.push(`- Rival "${r.entry_name}" (rank ${r.rank}, ${r.total} pts): captain ${cap?.web_name ?? '?'}; owns that David doesn't: ${diffs.join(', ')}`);
      }
    }
  }
} else L.push('League standings not available yet (season not started or league empty).');

H('CAPTAINCY RANKING (from squad)');
if (squad.length) {
  head(['Player', 'ep_next', 'Next fixture', 'FDR', 'Verdict']);
  const caps = squad.filter(e => e.element_type >= 3 && e.status === 'a').map(e => {
    const f = (teamFx[e.team] || [])[0];
    return { e, ep: n(e.ep_next), f };
  }).sort((a, b) => b.ep - a.ep).slice(0, 5);
  caps.forEach((c, i) => row([c.e.web_name, c.e.ep_next, c.f ? `${c.f.opp} (${c.f.ha})` : '-', c.f?.fdr ?? '-', i === 0 ? 'CAPTAIN' : i === 1 ? 'vice' : '']));
}

H('MODEL SCORE — top targets by position (score = form/PPG + ep_next + xGI/90 + DefCon + fixtures)');
for (const pos of [1, 2, 3, 4]) {
  const top = bs.elements.filter(e => e.element_type === pos && e.status === 'a' && playedEnough(e))
    .map(e => ({ e, s: score(e) })).sort((a, b) => b.s - a.s).slice(0, pos === 1 ? 4 : 8);
  L.push(`\n**${POS[pos]}**`);
  head(['Player', 'Team', '£', 'Owned%', 'Score', 'Form', 'ep_next', 'xGI/90', 'DefCon/90', 'Next 3 avg FDR']);
  for (const { e, s } of top) row([e.web_name, T[e.team], money(e), e.selected_by_percent, s, e.form, e.ep_next, per90(n(e.expected_goal_involvements), e).toFixed(2), e.defensive_contribution_per_90, avgFdr(e.team, 3).toFixed(1)]);
}

H('DEFCON BANKERS (hidden +2/game: DEF ≥10, MID ≥12 actions/90)');
head(['Player', 'Team', 'Pos', '£', 'DefCon/90', 'Season pts']);
bs.elements.filter(e => e.status === 'a' && e.minutes >= 900 && ((e.element_type === 2 && n(e.defensive_contribution_per_90) >= 10) || (e.element_type === 3 && n(e.defensive_contribution_per_90) >= 12)))
  .sort((a, b) => n(b.defensive_contribution_per_90) - n(a.defensive_contribution_per_90)).slice(0, 12)
  .forEach(e => row([e.web_name, T[e.team], POS[e.element_type], money(e), e.defensive_contribution_per_90, e.total_points]));

H('xGI TRUTH-TELLER');
const pool = bs.elements.filter(e => e.status === 'a' && e.minutes >= 900 && n(e.expected_goal_involvements) > 3);
L.push('**Buy low (unlucky):**');
head(['Player', 'Team', '£', 'GI − xGI']);
pool.map(e => ({ e, d: xgiDiff(e) })).filter(x => x.d <= -2.5).sort((a, b) => a.d - b.d).slice(0, 6)
  .forEach(({ e, d }) => row([e.web_name, T[e.team], money(e), d.toFixed(1)]));
L.push('\n**Regression risk (riding luck):**');
head(['Player', 'Team', '£', 'GI − xGI']);
pool.map(e => ({ e, d: xgiDiff(e) })).filter(x => x.d >= 5).sort((a, b) => b.d - a.d).slice(0, 6)
  .forEach(({ e, d }) => row([e.web_name, T[e.team], money(e), '+' + d.toFixed(1)]));

H('PRICE WATCH (net transfers this GW)');
const net = e => e.transfers_in_event - e.transfers_out_event;
L.push('**Likely risers:** ' + bs.elements.slice().sort((a, b) => net(b) - net(a)).slice(0, 8).map(e => `${e.web_name} (+${net(e)})`).join(', '));
L.push('**Likely fallers:** ' + bs.elements.slice().sort((a, b) => net(a) - net(b)).slice(0, 8).map(e => `${e.web_name} (${net(e)})`).join(', '));
const mineFalling = squad.filter(e => net(e) < -50000).map(e => e.web_name);
if (mineFalling.length) L.push(`**In David's squad at drop risk:** ${mineFalling.join(', ')}`);
if (prev) {
  const priceMoves = bs.elements.filter(e => prev.players[e.id] && prev.players[e.id].p !== e.now_cost)
    .map(e => `${e.web_name} ${(prev.players[e.id].p / 10).toFixed(1)}→${money(e)}`);
  if (priceMoves.length) L.push(`**Price changes since last build:** ${priceMoves.slice(0, 15).join(', ')}${priceMoves.length > 15 ? ` (+${priceMoves.length - 15} more)` : ''}`);
}

H('DIFFERENTIALS (<10% owned, high model score)');
head(['Player', 'Team', 'Pos', '£', 'Owned%', 'Score']);
bs.elements.filter(e => e.status === 'a' && n(e.selected_by_percent) < 10 && playedEnough(e))
  .map(e => ({ e, s: score(e) })).sort((a, b) => b.s - a.s).slice(0, 8)
  .forEach(({ e, s }) => row([e.web_name, T[e.team], POS[e.element_type], money(e), e.selected_by_percent, s]));

H('FIXTURE DIFFICULTY — next 6 (sorted easiest first)');
head(['Team', 'Avg FDR', 'Fixtures']);
bs.teams.map(t => ({ t, a: avgFdr(t.id, 6), fx: (teamFx[t.id] || []).map(f => `GW${f.gw}:${f.opp}(${f.ha})${f.fdr}`).join(' ') }))
  .sort((x, y) => x.a - y.a)
  .forEach(({ t, a, fx }) => row([t.short_name, a.toFixed(2), fx]));

// ---------- write outputs ----------
mkdirSync('docs', { recursive: true });
mkdirSync('snapshots', { recursive: true });
writeFileSync('docs/briefing.md', L.join('\n') + '\n');
if (next) writeFileSync(`snapshots/gw${next.id}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(snapNow));
writeFileSync(snapPath, JSON.stringify(snapNow));
console.log(`briefing.md written (${(L.join('\n').length / 1024).toFixed(1)} KB) for ${next?.name ?? 'end of season'}`);
