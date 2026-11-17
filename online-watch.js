/* ==========================================================================
   online-watch.js : Super Admin dashboard එකේ "Online Now" REAL-TIME.
   Admin / QAT ඕනෑම කෙනෙක් log වූ විගස ඒ මොහොතේම පෙන්වයි.
   ========================================================================== */
(function () {
    const seen = new Map();
    const kicked = new Set();
    let ch = null, ctrlCh = null, started = false;

    const $ = id => document.getElementById(id);
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const client = () => (typeof supabaseClient !== 'undefined' && supabaseClient ? supabaseClient : window.LMS?.db);

    async function syncAccounts() {
        const c = client();
        if (!c) return;
        try {
            const [a, q, p] = await Promise.all([
                c.from('admins').select('admin_g_id, status, department'),
                c.from('qats').select('qat_g_id, status, department'),
                c.from('user_presence').select('gid, name, role, department, last_seen').order('last_seen', { ascending: false }).limit(100)
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
                const freshKeys = new Set();
                
                p.data.forEach(user => {
                    if (!user.gid) return;
                    const gidUpper = String(user.gid).trim().toUpperCase();
                    if (kicked.has(user.gid) || disabledAccounts.has(gidUpper)) return;

                    const lastSeenMs = user.last_seen ? new Date(user.last_seen).getTime() : 0;
                    // Active if last_seen was in the last 70 seconds
                    if (Math.abs(now - lastSeenMs) <= 70000) {
                        const userRole = (user.role && String(user.role).toLowerCase() === 'qat') ? 'qat' : 'admin';
                        const mapKey = `${userRole}_${String(user.gid).trim()}`;
                        freshKeys.add(mapKey);
                        
                        const prev = seen.get(mapKey);
                        const sinceTime = prev?.m?.since || lastSeenMs || now;

                        seen.set(mapKey, {
                            m: {
                                role: userRole,
                                gid: user.gid,
                                name: user.name || user.gid,
                                department: user.department || 'Training',
                                since: sinceTime
                            },
                            at: now,
                            source: prev ? prev.source : 'db'
                        });
                    }
                });

                for (const [k, val] of seen.entries()) {
                    if (val.source === 'db' && !freshKeys.has(k)) {
                        seen.delete(k);
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

        // 1. Check Realtime Presence Channel
        if (ch && typeof ch.presenceState === 'function') {
            try {
                const state = ch.presenceState();
                Object.keys(state).forEach(key => {
                    const metas = state[key] || [];
                    metas.forEach(m => {
                        if (!m || (m.role !== 'admin' && m.role !== 'qat') || m.leaving) return;
                        if (kicked.has(m.gid)) return;

                        const mapKey = `${m.role}_${String(m.gid).trim()}`;
                        seen.set(mapKey, { m, at: now, source: 'realtime' });
                    });
                });
            } catch (e) {
                console.warn('presenceState error:', e);
            }
        }

        // Clean up kicked users
        for (const [k, val] of seen) {
            if (kicked.has(val.m.gid)) {
                seen.delete(k);
            }
        }

        const session = window.LMS?.getSession();
        const loggedDept = (session?.user?.department || 'General').toLowerCase();
        const isGeneral = loggedDept === 'general' || loggedDept === 'all';

        let allRows = [...seen.values()].map(v => v.m)
            .sort((a, b) => a.role === b.role ? String(a.gid).localeCompare(String(b.gid)) : (a.role === 'admin' ? -1 : 1));

        // If Department Super Admin (e.g. HR Super Admin) -> filter only that department!
        if (!isGeneral) {
            allRows = allRows.filter(r => (r.department || 'Training').toLowerCase() === loggedDept);
        }

        // Realtime Counters
        if ($('online-admins')) $('online-admins').textContent = allRows.filter(r => r.role === 'admin').length;
        if ($('online-qats')) $('online-qats').textContent = allRows.filter(r => r.role === 'qat').length;

        // Render Online Table
        $('online-tbody').innerHTML = allRows.length ? allRows.map(r => {
            const badge = r.role === 'admin' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600';
            const mins = Math.floor((now - (r.since || now)) / 60000);
            const since = mins < 1 ? 'දැන් (Just now)' : mins + ' min ago';
            return `<tr class="hover:bg-gray-50/50">
                <td class="py-2.5 px-3"><span class="px-2.5 py-1 text-xs font-semibold ${badge} rounded-full">${r.role === 'admin' ? 'Admin' : 'QAT'}</span></td>
                <td class="py-2.5 px-3 font-mono text-xs font-semibold text-stone-700">${esc(r.gid)}</td>
                <td class="py-2.5 px-3 text-sm text-stone-800 font-medium">${esc(r.name)}</td>
                <td class="py-2.5 px-3 text-xs text-stone-600 font-medium">${esc(r.department || 'Training')}</td>
                <td class="py-2.5 px-3 text-xs text-stone-500">${since}</td>
            </tr>`;
        }).join('') : `<tr><td colspan="5" class="py-4 text-center text-stone-400 text-sm">දැන් කිසිවෙකු online නෑ (No active members online)</td></tr>`;
    }

    function start() {
        if (started) return;
        started = true;
        const c = client();
        if (c && typeof c.channel === 'function') {
            try {
                ch = c.channel('lms-online', { config: { presence: { key: 'super_admin_watcher' } } });
                ch.on('presence', { event: 'sync' }, refresh)
                    .on('presence', { event: 'join' }, ({ newPresences }) => {
                        (newPresences || []).forEach(m => {
                            if (m && !m.leaving && (m.role === 'admin' || m.role === 'qat')) {
                                if (!kicked.has(m.gid)) {
                                    const mapKey = `${m.role}_${String(m.gid).trim()}`;
                                    seen.set(mapKey, { m, at: Date.now(), source: 'realtime' });
                                }
                            }
                        });
                        refresh();
                    })
                    .on('presence', { event: 'leave' }, ({ leftPresences }) => {
                        (leftPresences || []).forEach(lp => {
                            if (lp && lp.gid) {
                                seen.delete(`admin_${String(lp.gid).trim()}`);
                                seen.delete(`qat_${String(lp.gid).trim()}`);
                            }
                        });
                        refresh();
                    })
                    .subscribe();

                ctrlCh = c.channel('lms-control');
                ctrlCh.on('broadcast', { event: 'user_online' }, msg => {
                    const p = msg?.payload;
                    if (p && p.gid && (p.role === 'admin' || p.role === 'qat')) {
                        const mapKey = `${p.role}_${String(p.gid).trim()}`;
                        seen.set(mapKey, {
                            m: { role: p.role, gid: p.gid, name: p.name || p.gid, department: p.department || 'Training', since: p.since || Date.now() },
                            at: Date.now(),
                            source: 'realtime'
                        });
                        refresh();
                    }
                }).on('broadcast', { event: 'user_offline' }, msg => {
                    const p = msg?.payload;
                    if (p && p.gid) {
                        seen.delete(`admin_${String(p.gid).trim()}`);
                        seen.delete(`qat_${String(p.gid).trim()}`);
                        refresh();
                    }
                }).on('broadcast', { event: 'kick' }, msg => {
                    const gid = msg?.payload?.gid;
                    if (!gid) return;
                    kicked.add(gid);
                    seen.delete(`admin_${gid}`);
                    seen.delete(`qat_${gid}`);
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
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
