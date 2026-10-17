import { createClient } from 'jsr:@supabase/supabase-js@2';

const B = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const H = { 'user-agent': 'Mozilla/5.0', accept: 'application/json' };

async function j(url: string) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: H });
    if (r.ok) return await r.json();
    await new Promise((s) => setTimeout(s, 800));
  }
  throw new Error('ESPN non risponde: ' + url);
}

function etDate(d: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const ymd = (s: string) => s.replaceAll('-', '');
const court = (pos: string) => (/G/.test(pos || '') ? 'BC' : 'FC');
const num = (v: any) => { const n = parseInt(String(v ?? '').split('-')[0]); return isNaN(n) ? 0 : n; };
const pair = (v: any) => { const [a, b] = String(v ?? '0-0').split('-'); return [parseInt(a) || 0, parseInt(b) || 0]; };
const score = (s: any) => { const v = typeof s === 'object' && s ? (s.value ?? s.displayValue) : s; return parseInt(v) || 0; };

function gameRow(e: any, game_date?: string) {
  const c = e.competitions[0];
  const home = c.competitors.find((x: any) => x.homeAway === 'home');
  const away = c.competitors.find((x: any) => x.homeAway === 'away');
  const st = c.status || e.status;
  return {
    id: e.id,
    game_date: game_date ?? etDate(new Date(e.date)),
    start_time: e.date,
    home_abbr: home?.team?.abbreviation, away_abbr: away?.team?.abbreviation,
    home_score: score(home?.score), away_score: score(away?.score),
    state: st?.type?.state, status_detail: st?.type?.shortDetail,
    season_type: e.season?.type ?? e.seasonType?.type ?? 2,
    updated_at: new Date().toISOString(),
  };
}

async function nbaTeams() {
  const t = await j(B + '/teams');
  return t.sports[0].leagues[0].teams.map((x: any) => x.team);
}

// ---------- giocatori + infortuni ----------
async function syncPlayers() {
  const teams = await nbaTeams();
  const rows: any[] = [];
  await Promise.all(teams.map(async (tm: any) => {
    const r = await j(`${B}/teams/${tm.id}/roster`);
    for (const a of r.athletes || []) {
      const pos = a.position?.abbreviation || '';
      rows.push({ id: a.id, name: a.displayName, team_abbr: tm.abbreviation, team_id: tm.id, position: pos,
        court: court(pos), headshot: a.headshot?.href ?? null, active: true, updated_at: new Date().toISOString() });
    }
  }));
  const ids = rows.map((r) => r.id);
  await sb.from('players').update({ active: false, team_abbr: null }).not('id', 'in', `(${ids.join(',')})`);
  for (let i = 0; i < rows.length; i += 300) {
    const { error } = await sb.from('players').upsert(rows.slice(i, i + 300));
    if (error) throw error;
  }
  const n = await syncInjuries();
  return { players: rows.length, injuries: n };
}

async function syncInjuries() {
  const d = await j(B + '/injuries');
  const inj: any[] = [];
  for (const t of d.injuries || []) for (const i of t.injuries || []) {
    const href = (i.athlete?.links || []).map((l: any) => l.href).join(' ');
    const m = href.match(/\/id\/(\d+)/);
    if (m) inj.push({ id: m[1], status: i.status, note: i.shortComment || i.longComment || '' });
  }
  await sb.from('players').update({ injury_status: null, injury_note: null }).not('injury_status', 'is', null);
  for (const x of inj) await sb.from('players').update({ injury_status: x.status, injury_note: x.note }).eq('id', x.id);
  return inj.length;
}

// ---------- medie della stagione precedente (per l'asta) ----------
async function syncLastSeason(season: number) {
  const url = `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&page=1&limit=1000&sort=general.avgMinutes:desc&season=${season}&seasontype=2`;
  const d = await j(url);
  const names: Record<string, string[]> = {};
  for (const c of d.categories || []) names[c.name] = c.names;
  const rows: any[] = [];
  for (const a of d.athletes || []) {
    const v: Record<string, number> = {};
    for (const c of a.categories || []) {
      const vals = c.totals || c.values || [];
      (names[c.name] || []).forEach((n, i) => (v[n] = parseFloat(vals[i]) || 0));
    }
    const gp = v.gamesPlayed || 0;
    rows.push({
      player_id: a.athlete.id, season, gp, min: v.avgMinutes, pts: v.avgPoints, reb: v.avgRebounds, ast: v.avgAssists,
      stl: v.avgSteals, blk: v.avgBlocks, tov: v.avgTurnovers, fg3m: v.avgThreePointFieldGoalsMade,
      fg_miss: +((v.avgFieldGoalsAttempted || 0) - (v.avgFieldGoalsMade || 0)).toFixed(1),
      ft_miss: +((v.avgFreeThrowsAttempted || 0) - (v.avgFreeThrowsMade || 0)).toFixed(1),
      pf: v.avgFouls, dd: v.doubleDouble || 0, td: v.tripleDouble || 0,
    });
  }
  for (let i = 0; i < rows.length; i += 300) {
    const { error } = await sb.from('player_last_season').upsert(rows.slice(i, i + 300));
    if (error) throw error;
  }
  return { players: rows.length };
}

// ---------- calendario stagione (dal calendario di ogni squadra) ----------
async function syncSchedule() {
  const teams = await nbaTeams();
  const map = new Map<string, any>();
  await Promise.all(teams.map(async (tm: any) => {
    const s = await j(`${B}/teams/${tm.id}/schedule`);
    for (const e of s.events || []) map.set(e.id, gameRow(e));
  }));
  const { data: synced } = await sb.from('games').select('id').eq('final_synced', true);
  const skip = new Set((synced || []).map((x: any) => x.id));
  const rows = [...map.values()].filter((r) => !skip.has(r.id));
  for (let i = 0; i < rows.length; i += 300) {
    const { error } = await sb.from('games').upsert(rows.slice(i, i + 300));
    if (error) throw error;
  }
  return { games: rows.length };
}

// ---------- statistiche di una giornata ----------
async function syncDay(date: string, force = false) {
  const d = await j(`${B}/scoreboard?dates=${ymd(date)}`);
  const games = (d.events || []).map((e: any) => gameRow(e, date));
  if (games.length) {
    const { error } = await sb.from('games').upsert(games);
    if (error) throw error;
  }
  const { data: done } = await sb.from('games').select('id').eq('game_date', date).eq('final_synced', true);
  const doneIds = new Set((done || []).map((x: any) => x.id));
  let fetched = 0;
  for (const g of games) {
    if (g.state === 'pre') continue;
    if (!force && doneIds.has(g.id)) continue;
    const s = await j(`${B}/summary?event=${g.id}`);
    const rows: any[] = [];
    for (const team of s.boxscore?.players || []) {
      const st = team.statistics?.[0]; if (!st) continue;
      const k: string[] = st.keys || [];
      const idx = (name: string) => k.indexOf(name);
      for (const a of st.athletes || []) {
        const v = a.stats || [];
        const get = (name: string) => (idx(name) >= 0 ? v[idx(name)] : '0');
        const [fgm, fga] = pair(get('fieldGoalsMade-fieldGoalsAttempted'));
        const [f3m, f3a] = pair(get('threePointFieldGoalsMade-threePointFieldGoalsAttempted'));
        const [ftm, fta] = pair(get('freeThrowsMade-freeThrowsAttempted'));
        rows.push({
          game_id: g.id, player_id: a.athlete.id, game_date: date,
          min: a.didNotPlay || !v.length ? 0 : num(get('minutes')),
          pts: num(get('points')), reb: num(get('rebounds')), ast: num(get('assists')),
          stl: num(get('steals')), blk: num(get('blocks')), tov: num(get('turnovers')),
          fgm, fga, fg3m: f3m, fg3a: f3a, ftm, fta,
          oreb: num(get('offensiveRebounds')), dreb: num(get('defensiveRebounds')), pf: num(get('fouls')),
          dnp: !!a.didNotPlay || !v.length, updated_at: new Date().toISOString(),
        });
      }
    }
    if (rows.length) {
      const { error } = await sb.from('player_stats').upsert(rows);
      if (error) throw error;
    }
    if (g.state === 'post') await sb.from('games').update({ final_synced: true }).eq('id', g.id);
    fetched++;
  }
  const { data: n, error } = await sb.rpc('compute_scores', { p_date: date });
  if (error) throw error;
  return { date, games: games.length, boxscores: fetched, team_scores: n };
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const { data: ok } = await sb.rpc('check_sync_key', { p_key: u.searchParams.get('key') || '' });
  if (!ok) return new Response(JSON.stringify({ error: 'chiave non valida' }), { status: 401, headers: { 'content-type': 'application/json' } });
  const job = u.searchParams.get('job') || 'live';
  const out: any = { job };
  try {
    if (job === 'players') out.result = await syncPlayers();
    else if (job === 'injuries') out.result = { injuries: await syncInjuries() };
    else if (job === 'schedule') out.result = await syncSchedule();
    else if (job === 'lastseason') out.result = await syncLastSeason(parseInt(u.searchParams.get('season') || '2026'));
    else if (job === 'day') out.result = await syncDay(u.searchParams.get('date')!, u.searchParams.get('force') === '1');
    else {
      const now = new Date();
      const today = etDate(now);
      const yest = etDate(new Date(now.getTime() - 86400000));
      out.result = [await syncDay(yest), await syncDay(today)];
    }
    await sb.from('sync_log').insert({ kind: job, ok: true, info: out.result });
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    await sb.from('sync_log').insert({ kind: job, ok: false, info: { error: msg } });
    return new Response(JSON.stringify({ job, error: msg }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
