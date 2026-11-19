/* ==========================================================================
   lms-core.js : GSS LMS shared core (Session, Roles, Guard, Presence, Sidebar)
   ========================================================================== */
(function () {
    'use strict';

    /* ---------- Favicon (GSS Logo on all LMS pages) ---------- */
    if (document.head && !document.querySelector('link[rel="icon"], link[rel="shortcut icon"]')) {
        const icon = document.createElement('link');
        icon.rel = 'icon';
        icon.type = 'image/jpeg';
        icon.href = 'gsspicture.jpg';
        document.head.appendChild(icon);
    }

    const SUPABASE_URL = 'https://vdglyvehezapesbrovqp.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_t0AeLmN1tQkQLaH5s968eA_KSeFdTGl';

    const LEVEL = { super_admin: 3, admin: 2, qat: 1 };
    const HOME = {
        super_admin: 'super-admin-dashboard.html',
        admin: 'admin-dashboard.html',
        qat: 'qat-dashboard.html'
    };
    const SESSION_KEYS = {
        super_admin: 'currentSuperAdmin',
        admin: 'currentAdmin',
        qat: 'currentQat'
    };

    /* ---------- i18n ---------- */
    const DICT = {
        en: {
            dashboard: 'Dashboard', superDash: 'Super Admin', adminDash: 'Admin Dashboard', qatDash: 'QAT Dashboard',
            adminRegister: 'Admin Register', adminDetails: 'Admin Details', qatDetails: 'QAT Details', qatRegister: 'QAT Register',
            addCourse: 'Add Course', courses: 'Courses', dataMgmt: 'Data Management', profile: 'Profile', settings: 'Settings',
            logout: 'Logout', welcome: 'Welcome back', language: 'සිංහල'
        },
        si: {
            dashboard: 'උපකරණ පුවරුව', superDash: 'සුපිරි පරිපාලක', adminDash: 'පරිපාලක පුවරුව', qatDash: 'QAT පුවරුව',
            adminRegister: 'පරිපාලක ලියාපදිංචිය', adminDetails: 'පරිපාලක විස්තර', qatDetails: 'QAT විස්තර', qatRegister: 'QAT ලියාපදිංචිය',
            addCourse: 'පාඨමාලාව එක් කරන්න', courses: 'පාඨමාලා', dataMgmt: 'දත්ත කළමනාකරණය', profile: 'පැතිකඩ', settings: 'සැකසුම්',
            logout: 'ඉවත් වන්න', welcome: 'නැවත සාදරයෙන් පිළිගනිමු', language: 'English'
        }
    };
    const getLang = () => (localStorage.getItem('lms_lang') === 'si' ? 'si' : 'en');
    const t = key => (DICT[getLang()][key] ?? DICT.en[key] ?? key);

    /* ---------- Session ---------- */
    function read(key) {
        try { return JSON.parse(localStorage.getItem(key) || 'null'); }
        catch (_) { return null; }
    }

    function build(role, user) {
        return {
            role,
            user,
            gid: user.super_admin_g_id || user.admin_g_id || user.qat_g_id || null,
            name: user.super_admin_name || user.admin_name || user.name || user.user_name || 'User'
        };
    }

    function getSession() {
        const sa = read(SESSION_KEYS.super_admin);
        if (sa && sa.user_name && sa.bootstrap !== true) return build('super_admin', sa);
        const ad = read(SESSION_KEYS.admin);
        if (ad) return build('admin', ad);
        const qt = read(SESSION_KEYS.qat);
        if (qt) return build('qat', qt);
        return null;
    }

    const hasRole = (session, roles) => !!session && roles.includes(session.role);
    const atLeast = (session, minRole) => !!session && LEVEL[session.role] >= LEVEL[minRole];

    /* ---------- Dual-Sync Online Presence (Realtime + Heartbeat DB) ---------- */
    let presenceCh = null, controlCh = null, presenceMeta = null, presenceStarted = false, heartbeatTimer = null;

    async function sendDbPresencePing(s, isOnline = true) {
        if (!window.supabase || !s || !s.gid) return;
        const db = window.LMS.db;
        try {
            if (isOnline) {
                await db.from('user_presence').upsert({
                    gid: String(s.gid).trim(),
                    name: s.name,
                    role: s.role,
                    last_seen: new Date().toISOString()
                }, { onConflict: 'gid' });
            } else {
                await db.from('user_presence').delete().eq('gid', String(s.gid).trim());
            }
        } catch (err) {
            console.warn('DB Presence error:', err);
        }
    }

    function startPresence() {
        if (presenceStarted) return;
        const s = getSession();
        if (!s || !s.gid || (s.role !== 'admin' && s.role !== 'qat')) return;
        presenceStarted = true;

        const run = async () => {
            if (!window.supabase) {
                console.warn('presence: supabase-js not loaded');
                return;
            }
            const db = window.LMS.db;
            const since = Number(sessionStorage.getItem('lms_online_since')) || Date.now();
            sessionStorage.setItem('lms_online_since', String(since));
            presenceMeta = { role: s.role, gid: s.gid, name: s.name, since };

            await sendDbPresencePing(s, true);

            if (!(s.user && s.user.show_online_status === false)) {
                presenceCh = db.channel('lms-online', { config: { presence: { key: s.gid } } });
                presenceCh.subscribe(async st => {
                    if (st === 'SUBSCRIBED') {
                        await presenceCh.track(presenceMeta);
                    }
                });
            }

            controlCh = db.channel('lms-control');
            controlCh.on('broadcast', { event: 'kick' }, msg => {
                if (msg && msg.payload && msg.payload.gid === s.gid) {
                    alert('ඔබේ account එක disable / delete කර ඇත. නැවත login වෙන්න.');
                    logout();
                }
            }).subscribe(async st => {
                if (st === 'SUBSCRIBED') {
                    await controlCh.send({ type: 'broadcast', event: 'user_online', payload: presenceMeta });
                }
            });

            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(() => sendDbPresencePing(s, true), 25000);

            window.addEventListener('pagehide', () => {
                try {
                    if (controlCh) controlCh.send({ type: 'broadcast', event: 'user_offline', payload: { gid: s.gid } });
                    if (presenceCh) db.removeChannel(presenceCh);
                } catch (_) {}
            });
        };

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
        else run();
    }

    async function stopPresence() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        const s = getSession();
        if (s && s.gid) {
            await sendDbPresencePing(s, false);
        }
        if (!window.supabase) return;
        const db = window.LMS.db;

        if (controlCh) {
            try {
                await controlCh.send({ type: 'broadcast', event: 'user_offline', payload: { gid: s ? s.gid : '' } });
                await db.removeChannel(controlCh);
            } catch (_) {}
            controlCh = null;
        }
        if (presenceCh) {
            try {
                if (presenceMeta) await presenceCh.track({ ...presenceMeta, leaving: true });
                await db.removeChannel(presenceCh);
            } catch (_) {}
            presenceCh = null;
        }
    }

    async function kick(gid) {
        if (!window.supabase || !gid) return;
        const db = window.LMS.db;
        const ch = controlCh || db.channel('lms-control');
        try {
            await ch.send({ type: 'broadcast', event: 'kick', payload: { gid } });
            await db.from('user_presence').delete().eq('gid', gid);
        } catch (e) { console.warn('kick:', e); }
    }

    function logout() {
        Promise.race([stopPresence(), new Promise(r => setTimeout(r, 800))]).then(() => {
            Object.values(SESSION_KEYS).forEach(k => localStorage.removeItem(k));
            localStorage.removeItem('currentLmsUserRole');
            sessionStorage.removeItem('lms_online_since');
            window.location.href = 'index.html';
        });
    }

    document.addEventListener('click', e => {
        const a = e.target.closest && e.target.closest('a[href="index.html"].text-rose-600');
        if (a && getSession()) { e.preventDefault(); logout(); }
    }, true);

    /* ---------- Guard ---------- */
    function guard(allowed) {
        document.documentElement.style.visibility = 'hidden';
        const s = getSession();
        if (!s) {
            const rawFile = location.pathname.split('/').pop() || 'index.html';
            const currentFile = rawFile && !rawFile.includes('.') ? `${rawFile}.html` : rawFile;
            window.location.replace('index.html?redirect=' + encodeURIComponent(currentFile + location.search));
            return null;
        }
        if (s.role !== 'super_admin' && allowed && !allowed.includes(s.role)) {
            alert('මේ page එකට ඔබට අවසර නැහැ.');
            window.location.replace(HOME[s.role]);
            return null;
        }
        document.documentElement.style.visibility = 'visible';
        startPresence();
        return s;
    }

    /* ---------- Sidebar ---------- */
    const I = {
        home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
        userAdd: 'M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z',
        users: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
        clip: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
        plus: 'M12 4v16m8-8H4',
        book: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
        data: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
        user: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
        cog: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z',
        out: 'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1',
        globe: 'M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
    };

    function menuFor(role) {
        const all = [
            ['super-admin-dashboard.html', 'superDash', I.home, ['super_admin']],
            ['admin-dashboard.html', 'dashboard', I.home, ['admin']],
            ['qat-dashboard.html', 'dashboard', I.home, ['qat']],
            ['admin-register.html', 'adminRegister', I.userAdd, ['super_admin']],
            ['admin-details.html', 'adminDetails', I.users, ['super_admin']],
            ['qat-register.html', 'qatRegister', I.userAdd, ['super_admin', 'admin']],
            ['qat-details.html', 'qatDetails', I.clip, ['super_admin', 'admin']],
            ['course-add.html', 'addCourse', I.plus, ['super_admin', 'admin']],
            ['course-view.html', 'courses', I.book, ['super_admin', 'admin', 'qat']],
            ['data-management.html', 'dataMgmt', I.data, ['super_admin']],
            ['profile.html', 'profile', I.user, ['super_admin', 'admin', 'qat']],
            ['setting.html', 'settings', I.cog, ['super_admin', 'admin', 'qat']]
        ];
        return all.filter(m => m[3].includes(role));
    }

    function renderSidebar(opts = {}) {
        const s = getSession();
        const nav = document.getElementById('sidebar-nav');
        if (!s || !nav) return;
        const rawHere = location.pathname.split('/').pop().toLowerCase();
        const here = rawHere && !rawHere.includes('.') ? `${rawHere}.html` : rawHere;
        const svg = d => `<svg class="w-6 h-6 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${d}"/></svg>`;
        const label = txt => `<span class="font-medium text-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap">${txt}</span>`;
        const row = (attrs, icon, txt, cls) => `<a ${attrs} class="flex items-center space-x-4 p-2.5 rounded-lg transition cursor-pointer ${cls}">${svg(icon)}${label(txt)}</a>`;
        const normal = 'text-stone-600 hover:bg-blue-50 hover:text-blue-600';
        const active = 'bg-blue-50 text-blue-600';

        let html = menuFor(s.role).map(([href, key, icon]) =>
            row(`href="${href}"`, icon, t(key), href.toLowerCase() === here ? active : normal)
        ).join('');
        html += (opts.extra || []).map((x, i) => row(`href="#" data-extra="${i}"`, x.icon, x.label, normal)).join('');
        html += row('href="#" data-act="lang"', I.globe, t('language'), normal);
        html += row('href="#" data-act="logout"', I.out, t('logout'), 'text-rose-600 hover:bg-rose-50');
        nav.innerHTML = html;

        if (!nav.dataset.bound) {
            nav.dataset.bound = '1';
            nav.addEventListener('click', e => {
                const a = e.target.closest('a');
                if (!a) return;
                if (a.dataset.act === 'logout') { e.preventDefault(); logout(); }
                else if (a.dataset.act === 'lang') {
                    e.preventDefault();
                    localStorage.setItem('lms_lang', getLang() === 'en' ? 'si' : 'en');
                    location.reload();
                } else if (a.dataset.extra !== undefined) {
                    e.preventDefault();
                    opts.extra[Number(a.dataset.extra)]?.onClick();
                }
            });
        }
    }

    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const round2 = n => Math.round(n * 100) / 100;
    const postgrestVal = v => `"${String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

    window.LMS = {
        config: { driveApiKey: '' },
        getSession,
        hasRole,
        atLeast,
        guard,
        logout,
        startPresence,
        stopPresence,
        kick,
        renderSidebar,
        t,
        getLang,
        esc,
        round2,
        postgrestVal,
        HOME,
        LEVEL,
        get db() {
            if (!window.supabase) throw new Error('Supabase client library not loaded.');
            return this._db || (this._db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
        }
    };
})();
