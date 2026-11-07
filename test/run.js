// Offline test of apps-script/Code.gs with fake Google + Meta + YouTube services. Run: node test/run.js
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
function makeEnv(opts = {}) {
  const props = { VIEWS_AT: '9000000000000000', EDIT_PIN: '1111', META_PAGE_TOKEN: 'PT', META_PAGE_ID: 'PAGE1', IG_USER_ID: 'IG1', YT_CLIENT_ID: 'c', YT_CLIENT_SECRET: 's', YT_REFRESH_TOKEN: 'r', ...(opts.props || {}) };
  const files = {}; let fid = 0, now = opts.now || Date.parse('2026-11-08T18:05:00Z'); const calls = []; const fail = opts.fail || {};
  const mkFile = (name, content) => { const id = 'F' + (++fid); files[id] = { id, name, content, shared: false }; return api(id); };
  const api = id => ({ getId: () => id, getBlob: () => ({ getDataAsString: () => files[id].content, getBytes: () => Buffer.from(files[id].content || 'x') }), setContent: c => { files[id].content = c; },
    setSharing: () => { files[id].shared = true; }, getSize: () => opts.size || 5 });
  const resp = (code, obj, headers = {}) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(obj), getHeaders: () => headers });
  const ctx = {
    console, Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(now); } static now() { return now; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    DriveApp: { createFile: (n, c) => mkFile(typeof n === 'string' ? n : 'img', c || 'IMG'), getFileById: id => { if (!files[id]) files[id] = { id, content: 'VIDEO', shared: false }; return api(id); }, Access: {}, Permission: {} },
    Utilities: { sleep: () => {}, formatDate: (d, tz, f) => { const m = d.getUTCMonth() + 1, day = d.getUTCDate(); const dst = (m > 3 && m < 11) || (m === 3 && day >= 8) || (m === 11 && day < 1); return dst ? '-07:00' : '-08:00'; } },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} }) },
    ContentService: { createTextOutput: t => ({ setMimeType: () => JSON.parse(t), t }), MimeType: { JSON: 1 } },
    Logger: { log: () => {} }, MailApp: { sendEmail: (...a) => calls.push(['mail', ...a]) }, Session: { getEffectiveUser: () => ({ getEmail: () => 'me@x' }) }, ScriptApp: { getOAuthToken: () => 'DRV' },
    UrlFetchApp: { fetch: (url, o = {}) => {
      calls.push([o.method || 'get', url, o.payload, o.headers]);
      const plat = url.includes('/IG1/') || url.includes('IGC') || url.includes('IGM') ? 'ig' : url.includes('video_reels') || url.includes('rupload') ? 'fb' : url.includes('youtube') || url.includes('oauth2') ? 'yt' : 'x';
      if (fail[plat] > 0 && !url.includes('fields=')) { fail[plat]--; return resp(500, { error: { message: plat + ' down' } }); }
      if (url.endsWith('/IG1/media')) return resp(200, { id: 'IGC' });
      if (url.includes('/IGC?')) return resp(200, { status_code: 'FINISHED' });
      if (url.endsWith('/IG1/media_publish')) return resp(200, { id: 'IGM' });
      if (url.includes('/IGM?')) return resp(200, { permalink: 'https://www.instagram.com/reel/ABC/' });
      if (url.includes('video_reels') && o.payload.upload_phase === 'start') return resp(200, { video_id: 'FBV', upload_url: 'https://rupload.facebook.com/video-upload/v21.0/FBV' });
      if (url.includes('rupload')) return resp(200, { success: true });
      if (url.includes('video_reels')) return resp(200, { success: true });
      if (url.includes('oauth2')) return resp(200, { access_token: 'YTT' });
      if (url.includes('uploadType=resumable')) return resp(200, {}, { Location: 'https://upload/yt/session' });
      if (url.includes('gradenext-inventory.vercel.app/ap/data.json')) return resp(200, (opts.site || {}).data || { cards: {}, plan: [] });
      if (url.includes('gradenext-inventory.vercel.app/api/plan') && o.method === 'post') { calls.push(['report', JSON.parse(o.payload)]); return resp(200, {}); }
      if (url.includes('gradenext-inventory.vercel.app/api/plan')) return resp(200, { ov: (opts.site || {}).ov || {} });
      if (url.includes('gradenext-inventory.vercel.app/api/approve')) return resp(200, { ap: (opts.site || {}).ap || {} });
      if (url.includes('gradenext-inventory.vercel.app/media/')) return { getBlob: () => ({ getAs: () => ({ setName: () => 'IMG' }) }) };
      if (url.includes('alt=media')) return { getBlob: () => ({ getBytes: () => Buffer.alloc(1) }) };
      if (url.includes('upload/yt/session')) { const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(o.headers['Content-Range']); calls.push(['range', m[0]]); return +m[2] + 1 < +m[3] ? resp(308, {}) : resp(200, { id: 'YT123' }); }
      if (url.includes('/me?')) return resp(200, { id: 'PAGE1' });
      if (url.includes('/IG1/media?fields=caption')) return resp(200, { data: (opts.igPosts || []) });
      if (url.includes('/video_reels?fields=')) return resp(200, { data: (opts.fbPosts || []) });
      if (url.includes('/IG1/media?fields=id,permalink')) return resp(200, { data: [{ id: 'M1', permalink: 'https://www.instagram.com/reel/ABC/' }] });
      if (url.includes('/M1/insights')) return resp(200, { data: [{ values: [{ value: 321 }] }] });
      if (url.includes('/777/video_insights')) return resp(200, { data: [{ values: [{ value: 45 }] }] });
      if (url.includes('/api/stats')) { return resp(200, { ok: true }); }
      return resp(200, {});
    } } };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8'), ctx);
  ctx.call = b => ctx.doPost({ postData: { contents: JSON.stringify(b) } });
  ctx.calls = calls; ctx.files = files; ctx.setNow = t => { now = Date.parse(t); }; ctx.fail = fail; return ctx;
}
let n = 0; const ok = m => { n++; console.log('  ok', n, m); };
// 1. PIN + upsert + list
let E = makeEnv();
assert.deepStrictEqual(E.call({ action: 'upsert', pin: '0000', item: { id: 'x04' } }), { error: 'pin' }); ok('wrong PIN is refused');
E.call({ action: 'upsert', pin: '1111', item: { id: 'x04', title: 'Draw a perfect square', fileId: 'VID1', coverId: 'COV1', date: '2026-11-08', time: '10:00', caption: 'Caption A', hashtags: '#gradenext #scratch', approved: true } });
assert.strictEqual(E.call({ action: 'list' }).items.length, 1); ok('video added to the queue (stored in a Drive JSON file)');
// 2. not due yet (Nov 8 10:00 PST = 18:00Z); now 17:59Z
E.setNow('2026-11-08T17:59:00Z'); E.runDue(); assert.strictEqual(E.call({ action: 'list' }).items[0].status, 'scheduled'); ok('nothing posts before its San Francisco time');
// 3. due -> posts to all three with the caption + hashtags
E.setNow('2026-11-08T18:01:00Z'); E.runDue(); let it = E.call({ action: 'list' }).items[0];
assert.strictEqual(it.status, 'posted'); assert.ok(it.done.ig.includes('instagram.com/reel')); assert.ok(it.done.fb.includes('facebook.com/reel')); assert.ok(it.done.yt.includes('youtube.com/shorts/YT123'));
const igCreate = E.calls.find(c => String(c[1]).endsWith('/IG1/media')); assert.ok(igCreate[2].caption.startsWith('Caption A\n\n#gradenext')); ok('posts Instagram + Facebook + YouTube Short at the time, with caption + hashtags, links saved');
assert.ok(E.files.VID1.shared); ok('video made link-readable for Meta to fetch it');
E.runDue(); assert.strictEqual(E.calls.filter(c => String(c[1]).endsWith('/IG1/media')).length, 1); ok('never posts the same video twice');
// 4. edit with pencil: untick YouTube, new caption; move with double-click
E = makeEnv(); E.call({ action: 'upsert', pin: '1111', item: { id: 'x10', title: 'Blocks or Python', fileId: 'V2', coverId: 'C2', date: '2026-11-09', time: '09:00', caption: 'old', approved: true } });
E.call({ action: 'edit', pin: '1111', id: 'x10', caption: 'New caption', hashtags: '#python', platforms: { ig: true, fb: true, yt: false } });
assert.deepStrictEqual(E.call({ action: 'move', pin: '1111', id: 'x10', date: '2026-11-09', time: '25:00' }), { error: 'date/time' }); ok('bad time is refused');
E.call({ action: 'move', pin: '1111', id: 'x10', date: '2026-11-10', time: '18:30' });
E.setNow('2026-11-10T02:31:00Z'); E.runDue(); assert.strictEqual(E.call({ action: 'list' }).items[0].status, 'scheduled'); ok('moved date/time is respected (old time does not post)');
E.setNow('2026-11-11T02:31:00Z'); E.runDue(); it = E.call({ action: 'list' }).items[0];
assert.strictEqual(it.status, 'posted'); assert.ok(!it.done.yt); assert.ok(!E.calls.some(c => String(c[1]).includes('youtube'))); ok('unticked YouTube is skipped, Instagram + Facebook posted');
assert.ok(E.calls.find(c => String(c[1]).endsWith('/IG1/media'))[2].caption === 'New caption\n\n#python'); ok('edited caption + hashtags are what gets posted');
// 5. not approved -> waits
E = makeEnv(); E.call({ action: 'upsert', pin: '1111', item: { id: 'x20', fileId: 'V3', date: '2026-11-01', time: '09:00', approved: false } }); E.runDue();
assert.strictEqual(E.call({ action: 'list' }).items[0].status, 'scheduled'); ok('waits for Dr. Shahid approval before posting');
// 6. Facebook down once -> partial -> next run posts only Facebook
E = makeEnv({ fail: { fb: 1 } }); E.call({ action: 'upsert', pin: '1111', item: { id: 'x16', fileId: 'V4', coverId: 'C4', date: '2026-11-07', time: '10:00', approved: true } });
E.setNow('2026-11-07T18:10:00Z'); E.runDue(); it = E.call({ action: 'list' }).items[0]; assert.strictEqual(it.status, 'partial'); assert.ok(it.done.ig && it.done.yt && !it.done.fb);
E.runDue(); it = E.call({ action: 'list' }).items[0]; assert.strictEqual(it.status, 'posted'); assert.strictEqual(E.calls.filter(c => String(c[1]).endsWith('/IG1/media')).length, 1); ok('a failed platform is retried next run without re-posting the others');
// 7. 3 failures -> failed + email
E = makeEnv({ fail: { ig: 9, fb: 9, yt: 9 } }); E.call({ action: 'upsert', pin: '1111', item: { id: 'x99', fileId: 'V5', coverId: 'C5', date: '2026-11-07', time: '10:00', approved: true } });
E.setNow('2026-11-07T18:10:00Z'); E.runDue(); E.runDue(); E.runDue(); it = E.call({ action: 'list' }).items[0];
assert.strictEqual(it.status, 'failed'); assert.ok(E.calls.some(c => c[0] === 'mail')); ok('after 3 failed tries it stops and emails an alert');
// 8. long YouTube video + summer time
E = makeEnv(); E.call({ action: 'upsert', pin: '1111', item: { id: 'sh1v', title: 'Curiosity', fileId: 'V6', coverId: 'C6', ytKind: 'video', date: '2026-07-01', time: '09:00', approved: true, platforms: { ig: false, fb: false, yt: true } } });
E.setNow('2026-07-01T15:59:00Z'); E.runDue(); assert.strictEqual(E.call({ action: 'list' }).items[0].status, 'scheduled');
E.setNow('2026-07-01T16:00:30Z'); E.runDue(); it = E.call({ action: 'list' }).items[0]; assert.ok(it.done.yt.includes('watch?v=YT123')); assert.ok(E.calls.some(c => String(c[1]).includes('thumbnails/set'))); ok('YouTube long video with thumbnail; daylight-saving time handled');
assert.ok(E.calls.some(c => String(c[1]).includes('recordingDetails') && JSON.stringify(c).includes('San Francisco'))); ok('YouTube location = San Francisco');
E = makeEnv(); E.call({ action: 'upsert', pin: '1111', item: { id: 'nc', title: 'No cover', fileId: 'V9', date: '2026-07-01', time: '09:00', approved: true } });
E.setNow('2026-07-01T16:00:30Z'); E.runDue(); it = E.call({ action: 'list' }).items[0]; assert.strictEqual(it.status, 'failed'); assert.ok(!E.calls.some(c => c[0] === 'post' && /media|video_reels|youtube/.test(String(c[1]))));
ok('strict: never posts without the cover');
E = makeEnv({ size: 80 * 1024 * 1024 }); E.call({ action: 'upsert', pin: '1111', item: { id: 'big', title: 'Big', fileId: 'VB', coverId: 'CB', ytCoverId: 'CJ', ytKind: 'video', date: '2026-07-01', time: '09:00', approved: true, platforms: { ig: false, fb: false, yt: true } } });
E.setNow('2026-07-01T16:00:30Z'); E.runDue(); it = E.call({ action: 'list' }).items[0]; assert.strictEqual(it.status, 'posted'); assert.strictEqual(E.calls.filter(c => c[0] === 'range').length, 3);
assert.ok(E.calls.some(c => String(c[1]).includes('thumbnails/set'))); ok('big video (80 MB) uploads to YouTube in pieces, JPG thumbnail set');
// ---- website-driven (Tasks tab is the boss) ----
const card = { k: 'x50', title: 'Test', fileId: 'VID50', cover: 'media/x50_cover.jpg', cap: ['Title line', 'Body text', '#gradenext #maths'], wide: false };
const site = (ov = {}, ap = { x50: { st: 'ok' } }, date = '2026-11-10', time = '09:00') => ({ data: { cards: { x50: card }, plan: [{ id: 'e-x50', k: 'x50', date, time, pl: ['ig', 'fb', 'yt'] }] }, ov, ap });
const noYT = { YT_REFRESH_TOKEN: '' };
E = makeEnv({ site: site({}, {}), now: Date.parse('2026-11-10T17:05:00Z') }); E.runDue();
assert.ok(!E.calls.some(c => String(c[1]).endsWith('/IG1/media'))); assert.ok(E.calls.some(c => c[0] === 'report' && c[1].patch.apSt === 'waiting')); ok('site: not approved by Dr. Shahid -> waits, Tasks shows "waiting"');
E = makeEnv({ site: site(), now: Date.parse('2026-11-10T16:55:00Z'), props: noYT }); E.runDue(); assert.ok(!E.calls.some(c => String(c[1]).endsWith('/IG1/media'))); ok('site: approved but not time yet (9:00 AM San Francisco) -> nothing posted');
E.setNow('2026-11-10T17:01:00Z'); E.runDue();
assert.strictEqual(E.calls.filter(c => String(c[1]).endsWith('/IG1/media')).length, 1); assert.ok(E.calls.find(c => String(c[1]).endsWith('/IG1/media'))[2].caption === 'Title line\n\nBody text\n\n#gradenext #maths');
assert.ok(!E.calls.some(c => String(c[1]).includes('youtube'))); const rp = E.calls.filter(c => c[0] === 'report').pop()[1];
assert.ok(rp.patch.done.ig && rp.patch.done.fb && /YouTube not connected/.test(rp.patch.apErr)); ok('site: approved + 9:00 AM SF -> Instagram + Facebook posted with caption/hashtags; ticks + links sent back; YouTube waits until connected');
E.runDue(); assert.strictEqual(E.calls.filter(c => String(c[1]).endsWith('/IG1/media')).length, 1); ok('site: next runs never post it again');
E = makeEnv({ site: site({ 'e-x50': { done: { ig: 'https://www.instagram.com/reel/HAND/' } } }), now: Date.parse('2026-11-10T17:01:00Z'), props: noYT }); E.runDue();
assert.ok(!E.calls.some(c => String(c[1]).endsWith('/IG1/media')) && E.calls.some(c => (c[0] === 'post' && String(c[1]).includes('video_reels')))); ok('site: posted by hand on Instagram -> only Facebook is posted');
E = makeEnv({ site: site({}, undefined, '2026-11-01'), now: Date.parse('2026-11-10T17:01:00Z'), props: noYT }); E.runDue();
assert.ok(!E.calls.some(c => String(c[1]).endsWith('/IG1/media'))); assert.strictEqual(E.call({ action: 'list' }).items[0].status, 'missed'); ok('site: more than 1 day late -> NOT posted by surprise, shows "missed"');
E = makeEnv({ site: site({ 'e-x50': { now: '2026-11-10T17:00:00Z' } }, undefined, '2026-11-01'), now: Date.parse('2026-11-10T17:01:00Z'), props: noYT }); E.runDue();
assert.ok(E.calls.some(c => String(c[1]).endsWith('/IG1/media'))); ok('site: "Post now" button posts it right away');
E = makeEnv({ site: site({ 'e-x50': { auto: 'off' } }), now: Date.parse('2026-11-10T17:01:00Z'), props: noYT }); E.runDue();
assert.ok(!E.calls.some(c => String(c[1]).endsWith('/IG1/media'))); ok('site: auto-post switched off -> nothing posted');
E = makeEnv({ site: site({ 'e-x50': { pl: ['ig'], cap: 'Edited caption', tags: '#edited' } }), now: Date.parse('2026-11-10T17:01:00Z'), props: noYT }); E.runDue();
assert.ok(E.calls.find(c => String(c[1]).endsWith('/IG1/media'))[2].caption === 'Edited caption\n\n#edited' && !E.calls.some(c => (c[0] === 'post' && String(c[1]).includes('video_reels')))); ok('site: pencil edits (caption, hashtags, Facebook unticked) are what gets posted');
E = makeEnv({ site: { data: { cards: { x05: { k: 'x05', fileId: 'V', links: { ig: 'https://www.instagram.com/reel/ABC/', fb: 'https://www.facebook.com/reel/777' } } }, plan: [] } }, props: { VIEWS_AT: '0' } });
E.runDue(); const st = E.calls.find(c => String(c[1]).includes('/api/stats'));
assert.ok(st && JSON.parse(st[2]).v.x05); ok('views: Instagram + Facebook views are read from Meta every hour and sent to the website Analysis');
E = makeEnv({ site: site({}, { x50: { st: 'fix' } }), now: Date.parse('2026-11-10T17:01:00Z'), props: noYT, igPosts: [{ caption: 'Title line\n\nBody', permalink: 'https://www.instagram.com/reel/BYHAND/', timestamp: '2026-11-10T10:00:00+0000' }], fbPosts: [{ id: '999', description: 'Other video', created_time: '2026-11-10T10:00:00+0000' }] });
E.runDue(); let rr = E.calls.filter(c => c[0] === 'report').pop()[1];
assert.strictEqual(rr.patch.done.ig, 'https://www.instagram.com/reel/BYHAND/'); assert.ok(!rr.patch.done.fb); ok('ticks: a real Instagram post with the same title is ticked + linked automatically; Facebook (not posted) stays unticked');
console.log(`\nALL ${n} CHECKS PASSED`);
