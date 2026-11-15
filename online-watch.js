/* ==========================================================================
   online-watch.js : Super Admin dashboard real-time Online Now watcher
   ========================================================================== */
(function () {
    'use strict';

    const seen = new Map();
    const kicked = new Set();
    let ch = null, ctrlCh = null, started = false;
    let selectedRoleFilter = 'all';

    const $ = id => document.getElementById(id);
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const client = () => window.LMS?.db || null;

    function cleanUi() {
        document.querySelectorAll('span').forEach(s => { if (s.textContent.includes('විනාඩි 3ක්')) s.remove(); });
        document.querySelectorAll('th').forEach(t => { if (t.textContent.trim().toLowerCase() === 'last active') t.textContent = 'Online since'; });

        const h = [...document.querySelectorAll('h3')].find(x => x.textContent.trim() === 'Online Now');
        if (h && !$('online-role-filter')) {
            const filterHtml = `
            <div class="flex items-center space-x-3">
                <select id="online-role-filter" aria-label="Filter online users by role" class="text-xs border border-stone-200 rounded-lg px-2.5 py-1.5 bg-white text-stone-700 focus:outline-none focus:ring-1 focus:ring-blue-500 font-medium">
                    <option value="all">All Departments / Roles</option>
                    <option value="admin">Admins Only</option>
                    <option value="qat">QATs Only</option>
                </select>
                <span id="online-status" class="text-xs text-stone-400">Connecting...</span>
            </div>`;
            h.parentElement.insertAdjacentHTML('afterend', filterHtml);

            $('online-role-filter').addEventListener('change', e => {
                selectedRoleFilter = e.target.value;
                refresh();
            });
        }
    }

    function setStatus(txt, ok) {
        const el = $('online-status');
        if (el) { el.textContent = txt; el.className = 'text-xs ' + (ok ? 'text-emerald-600' : 'text-stone-400'); }
    }

    async function syncAccounts() {
        const c = client();
        if (!c) return;
        try {
            const [a, q, p] = await Promise.all([
                c.from('admins').select('admin_g_id, status'),
                c.from('qats').select('qat_g_id, status'),
                c.from('user_presence').select('gid, name, role, last_seen').order('last_seen', { ascending: false }).limit(100)
            ]);

            const disabledAccounts = new Set();
            (a.data || []).forEach(r => {
                if (r.status && String(r.status).toLowerCase() === 'disabled') {
                    disabledAccounts.add(String(r.admin_g_id).trim().toUpperCase());
                }
            });
            (q.data || []).forEach(r => {
                if (r.status && String(r.status).toLowerCase() === 'disabled') {
                    disabledAccounts.add(String(r.qat_g_id).trim().toUpperCase());
                }
            });

            if (p && !p.error && Array.isArray(p.data)) {
                const now = Date.now();
                const freshGids = new Set();

                p.data.forEach(user => {
                    if (!user.gid) return;
                    const gidUpper = String(user.gid).trim().toUpperCase();
                    if (kicked.has(user.gid) || disabledAccounts.has(gidUpper)) return;

                    const lastSeenMs = user.last_seen ? new Date(user.last_seen).getTime() : 0;
                    if (now - lastSeenMs <= 60000) {
                        const userRole = (user.role && String(user.role).toLowerCase() === 'qat') ? 'qat' : 'admin';
                        freshGids.add(user.gid);

                        const prev = seen.get(user.gid);
                        const sinceTime = prev?.m?.since || lastSeenMs || now;

                        seen.set(user.gid, {
                            m: {
                                role: userRole,
                                gid: user.gid,
                                name: user.name || user.gid,
                                since: sinceTime
                            },
                            at: now,
                            source: prev ? prev.source : 'db'
                        });
                    }
                });

                for (const [gid, val] of seen.entries()) {
                    if (val.source === 'db' && !freshGids.has(gid)) {
                        seen.delete(gid);
                    }
                }
            }
            refresh();
        } catch (e) {
            console.warn('syncAccounts error:', e);
        }
    }

    function refresh() {
        if (!$('online-tbody')) return;
        const now = Date.now();

        if (ch && typeof ch.presenceState === 'function') {
            try {
                const state = ch.presenceState();
                Object.keys(state).forEach(key => {
                    const metas = state[key];
                    const m = metas[metas.length - 1];
                    if (!m || (m.role !== 'admin' && m.role !== 'qat') || m.leaving) return;
                    if (kicked.has(m.gid)) return;

                    seen.set(m.gid, { m, at: now, source: 'realtime' });
                });
            } catch (e) {
                console.warn('presenceState error:', e);
            }
        }

        for (const [k] of seen) {
            if (kicked.has(k)) seen.delete(k);
        }

        const allRows = [...seen.values()].map(v => v.m)
            .sort((a, b) => a.role === b.role ? String(a.gid).localeCompare(String(b.gid)) : (a.role === 'admin' ? -1 : 1));

        if ($('online-admins')) $('online-admins').textContent = allRows.filter(r => r.role === 'admin').length;
        if ($('online-qats')) $('online-qats').textContent = allRows.filter(r => r.role === 'qat').length;

        const rows = selectedRoleFilter === 'all' ? allRows : allRows.filter(r => r.role === selectedRoleFilter);

        $('online-tbody').innerHTML = rows.length ? rows.map(r => {
            const badge = r.role === 'admin' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600';
            const mins = Math.floor((now - (r.since || now)) / 60000);
            const since = mins < 1 ? 'දැන් (Just now)' : mins + ' min ago';
            return `<tr class="hover:bg-gray-50/50">
                <td class="py-2.5 px-3"><span class="px-2.5 py-1 text-xs font-semibold ${badge} rounded-full">${r.role === 'admin' ? 'Admin' : 'QAT'}</span></td>
                <td class="py-2.5 px-3 font-mono text-xs font-semibold text-stone-700">${esc(r.gid)}</td>
                <td class="py-2.5 px-3 text-sm text-stone-800 font-medium">${esc(r.name)}</td>
                <td class="py-2.5 px-3 text-xs text-stone-500">${since}</td>
            </tr>`;
        }).join('') : `<tr><td colspan="4" class="py-4 text-center text-stone-400 text-sm">දැන් කිසිවෙකු online නෑ (No active users online)</td></tr>`;
    }

    function start() {
        if (started) return;
        started = true;
        cleanUi();
        const c = client();
        if (c && typeof c.channel === 'function') {
            try {
                ch = c.channel('lms-online', { config: { presence: { key: 'super_admin_watcher' } } });
                ch.on('presence', { event: 'sync' }, refresh)
                    .on('presence', { event: 'join' }, ({ newPresences }) => {
                        (newPresences || []).forEach(m => {
                            if (m && !m.leaving && (m.role === 'admin' || m.role === 'qat')) {
                                if (!kicked.has(m.gid)) {
                                    seen.set(m.gid, { m, at: Date.now(), source: 'realtime' });
                                }
                            }
                        });
                        refresh();
                    })
                    .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
                        if (key && key !== 'super_admin_watcher') seen.delete(key);
                        (leftPresences || []).forEach(lp => {
                            if (lp && lp.gid) seen.delete(lp.gid);
                        });
                        refresh();
                    })
                    .subscribe(st => {
                        if (st === 'SUBSCRIBED') setStatus('● Realtime Live', true);
                        else setStatus('● Realtime connecting...', false);
                    });

                ctrlCh = c.channel('lms-control');
                ctrlCh.on('broadcast', { event: 'user_online' }, msg => {
                    const p = msg?.payload;
                    if (p && p.gid && (p.role === 'admin' || p.role === 'qat')) {
                        seen.set(p.gid, {
                            m: { role: p.role, gid: p.gid, name: p.name || p.gid, since: p.since || Date.now() },
                            at: Date.now(),
                            source: 'realtime'
                        });
                        refresh();
                    }
                }).on('broadcast', { event: 'user_offline' }, msg => {
                    const gid = msg?.payload?.gid;
                    if (gid) {
                        seen.delete(gid);
                        refresh();
                    }
                }).on('broadcast', { event: 'kick' }, msg => {
                    const gid = msg?.payload?.gid;
                    if (!gid) return;
                    kicked.add(gid);
                    seen.delete(gid);
                    refresh();
                    setTimeout(() => kicked.delete(gid), 8000);
                }).subscribe();
            } catch (e) {
                console.warn('Realtime channel init warning:', e);
            }
        }
        syncAccounts();
        refresh();
        setInterval(syncAccounts, 3000);
        setInterval(refresh, 1000);
    }

    window.loadOnline = function () { start(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();