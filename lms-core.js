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
            window.location.replace('index.html');
        });
    }

    document.addEventListener('click', e => {
        const a = e.target.closest && e.target.closest('a[href="index.html"].text-rose-600');
        if (a && getSession()) { e.preventDefault(); logout(); }
    }, true);

    /* ---------- Guard & Back/Forward History Protection ---------- */
    let guarded = false, guardAllowed = null, backLockInstalled = false;

    function normalizeFile(pathname) {
        const raw = (pathname || '').split('/').pop().toLowerCase() || 'index.html';
        return raw && !raw.includes('.') ? `${raw}.html` : raw;
    }

    function installHomeBackLock() {
        if (backLockInstalled) return;
        backLockInstalled = true;

        const pushInit = () => {
            if (!getSession()) return;
            try {
                if (!history.state || !history.state.__lmsHomeLock) {
                    history.pushState({ __lmsHomeLock: 'init' }, '', location.href);
                }
            } catch (_) {}
        };

        const armLock = () => {
            if (!getSession()) return;
            try {
                if (!history.state || history.state.__lmsHomeLock !== 'armed') {
                    history.pushState({ __lmsHomeLock: 'armed' }, '', location.href);
                }
            } catch (_) {}
        };

        pushInit();
        ['pointerdown', 'keydown', 'touchstart'].forEach(ev => {
            window.addEventListener(ev, armLock, { capture: true, passive: true });
        });
        window.addEventListener('popstate', () => {
            if (!getSession()) return;
            try {
                if (!history.state || history.state.__lmsHomeLock !== 'rearmed') {
                    history.pushState({ __lmsHomeLock: 'rearmed' }, '', location.href);
                }
            } catch (_) {}
        });
    }

    window.addEventListener('pageshow', e => {
        if (!guarded) return;
        const s = getSession();
        const currentFile = normalizeFile(location.pathname);

        if (!s) {
            document.documentElement.style.visibility = 'hidden';
            window.location.replace('index.html');
            return;
        }
        const homeFile = (HOME[s.role] || '').toLowerCase();
        const isOtherRoleHome = Object.values(HOME).some(h => h.toLowerCase() === currentFile) && currentFile !== homeFile;
        if (isOtherRoleHome || (s.role !== 'super_admin' && guardAllowed && !guardAllowed.includes(s.role))) {
            document.documentElement.style.visibility = 'hidden';
            window.location.replace(HOME[s.role]);
            return;
        }
        if (e.persisted) {
            window.location.reload();
            return;
        }
        if (currentFile === homeFile) {
            installHomeBackLock();
        }
    });

    function guard(allowed) {
        guarded = true;
        guardAllowed = allowed || null;
        document.documentElement.style.visibility = 'hidden';
        const s = getSession();
        const currentFile = normalizeFile(location.pathname);
        if (!s) {
            const rawFile = location.pathname.split('/').pop() || 'index.html';
            const targetFile = rawFile && !rawFile.includes('.') ? `${rawFile}.html` : rawFile;
            window.location.replace('index.html?redirect=' + encodeURIComponent(targetFile + location.search));
            return null;
        }
        const homeFile = (HOME[s.role] || '').toLowerCase();
        const isOtherRoleHome = Object.values(HOME).some(h => h.toLowerCase() === currentFile) && currentFile !== homeFile;
        if (isOtherRoleHome) {
            window.location.replace(HOME[s.role]);
            return null;
        }
        if (s.role !== 'super_admin' && allowed && !allowed.includes(s.role)) {
            alert('මේ page එකට ඔබට අවසර නැහැ.');
            window.location.replace(HOME[s.role]);
            return null;
        }
        if (currentFile === homeFile) {
            installHomeBackLock();
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
        applyTranslations();
    }

    /* ---------- Full-Page Sinhala Translator (Safe DOM + Dynamic Observer) ---------- */
    const SI_EXACT = {
        // Common & Titles
        'gss lms': 'GSS LMS',
        'welcome back': 'නැවත සාදරයෙන් පිළිගනිමු',
        'welcome back,': 'නැවත සාදරයෙන් පිළිගනිමු,',
        '• gss global system solution': '• GSS ග්ලෝබල් සිස්ටම් සොලියුෂන්',
        'dashboard': 'උපකරණ පුවරුව',
        'super admin': 'සුපිරි පරිපාලක',
        'super admin dashboard': 'සුපිරි පරිපාලක උපකරණ පුවරුව',
        'admin dashboard': 'පරිපාලක උපකරණ පුවරුව',
        'qat dashboard': 'QAT උපකරණ පුවරුව',
        'admin': 'පරිපාලක',
        'qat': 'QAT',
        'qat technician': 'QAT තාක්ෂණික ශිල්පී',
        'status': 'තත්ත්වය',
        'active': 'සක්‍රීයයි',
        'inactive': 'අක්‍රීයයි',
        'pending': 'පොරොත්තු',
        'passed': 'සමත්',
        'failed': 'අසමත්',
        'completed': 'සම්පූර්ණයි',
        'action': 'ක්‍රියාව',
        'actions': 'ක්‍රියාමාර්ග',
        'cancel': 'අවලංගු කරන්න',
        'save': 'සුරකින්න',
        'edit': 'සංස්කරණය',
        'delete': 'මකන්න',
        'reset': 'යළි සකසන්න',
        'loading...': 'පූරණය වෙමින්...',

        // Super Admin Dashboard
        'handover role': 'තනතුර පවරන්න',
        'change password': 'මුරපදය වෙනස් කරන්න',
        'department courses': 'දෙපාර්තමේන්තු පාඨමාලා',
        'department admins': 'දෙපාර්තමේන්තු පරිපාලකයින්',
        'enrolled qats': 'ලියාපදිංචි QAT සාමාජිකයින්',
        'view courses ›': 'පාඨමාලා බලන්න ›',
        'view admins ›': 'පරිපාලකයින් බලන්න ›',
        'view qats ›': 'QAT විස්තර බලන්න ›',
        'view all': 'සියල්ල බලන්න',
        'online now': 'දැන් සක්‍රීය අය (Online)',
        'admins online': 'සක්‍රීය පරිපාලකයින්',
        'qats online': 'සක්‍රීය QAT සාමාජිකයින්',
        'all departments (general super admin)': 'සියලුම දෙපාර්තමේන්තු (සාමාන්‍ය සුපිරි පරිපාලක)',
        'all departments / roles': 'සියලුම දෙපාර්තමේන්තු / තනතුරු',
        'admins only': 'පරිපාලකයින් පමණි',
        'qats only': 'QAT සාමාජිකයින් පමණි',
        'connecting...': 'සම්බන්ධ වෙමින්...',
        '● realtime live': '● සජීවීව සම්බන්ධයි',
        '● realtime connecting...': '● සජීවීව සම්බන්ධ වෙමින්...',
        'just now': 'දැන්',
        'දැන් (just now)': 'දැන්',
        'දැන් කිසිවෙකු online නෑ (no active users online)': 'දැන් කිසිවෙකු online නැත',
        'දැන් කිසිවෙකු online නෑ (no active members online)': 'දැන් කිසිවෙකු online නැත',
        'realtime: login වූ ගමන් පෙනේ, logout වූ ගමන් අයින් වේ': 'සජීවීව: Login වූ ගමන් පෙනේ, Logout වූ ගමන් ඉවත් වේ',
        'loading online members...': 'සක්‍රීය සාමාජිකයින් පූරණය වෙමින්...',
        'online since': 'සක්‍රීය වූ වේලාව',
        'general super admin only': 'සාමාන්‍ය සුපිරි පරිපාලක සඳහා පමණි',
        'course retake audit log (විශේෂ අවසර වාර්තාව)': 'පාඨමාලා Retake විශේෂ අවසර වාර්තාව',
        'date / time': 'දිනය / වේලාව',
        'department': 'දෙපාර්තමේන්තුව',
        'granted by (super admin)': 'අවසර දුන් (සුපිරි පරිපාලක)',
        'qat g id & name': 'QAT G ID සහ නම',
        'course': 'පාඨමාලාව',
        'loading audit logs...': 'Audit වාර්තා පූරණය වෙමින්...',
        'no retake actions recorded yet.': 'තවමත් retake අවසර ලබාදීම් වාර්තා වී නොමැත.',
        'failed to load audit logs.': 'Audit වාර්තා පූරණය කිරීම අසාර්ථක විය.',
        'department admin accounts': 'දෙපාර්තමේන්තු පරිපාලක ගිණුම්',
        'department qat accounts': 'දෙපාර්තමේන්තු QAT ගිණුම්',
        'loading from database...': 'දත්ත ගබඩාවෙන් පූරණය වෙමින්...',
        'loading candidates...': 'අපේක්ෂකයින් පූරණය වෙමින්...',
        'action for outgoing account': 'ඉවත්වන ගිණුම සඳහා ක්‍රියාමාර්ගය',
        'select successor (නව සුපිරි පරිපාලක)': 'නව සුපිරි පරිපාලක තෝරන්න',
        'deactivate account (ගිණුම අක්‍රිය කරන්න / ඉවත් වන්න)': 'ගිණුම අක්‍රිය කරන්න / ඉවත් වන්න',
        'demote to regular admin (සාමාන්‍ය admin කෙනෙකු ලෙස පවත්වාගන්න)': 'සාමාන්‍ය Admin කෙනෙකු ලෙස පවත්වාගන්න',
        'confirm with your password': 'ඔබේ මුරපදයෙන් තහවුරු කරන්න',
        'transfer ownership & logout': 'තනතුර පවරා ඉවත් වන්න',
        'qat performance & retake management': 'QAT ප්‍රතිඵල සහ Retake කළමනාකරණය',
        'review qat completion scores and manage course retake permissions.': 'QAT සාමාජිකයින්ගේ ලකුණු පරීක්ෂා කර නැවත පාඨමාලා හැදෑරීමේ (Retake) අවසර කළමනාකරණය කරන්න.',
        'qat g id': 'QAT G ID',
        'admin g id': 'Admin G ID',
        'admin id': 'Admin ID',
        'g id': 'G ID',
        'gid': 'GID',
        'course id': 'පාඨමාලා ID',
        'all qat g ids': 'සියලුම QAT G ID',
        'all admin g ids': 'සියලුම Admin G ID',
        'all course ids': 'සියලුම පාඨමාලා ID',
        'reset filters': 'පෙරහන් යළි සකසන්න',
        'apply filter': 'පෙරහන යොදන්න',
        'download excel': 'Excel බාගත කරන්න',
        'course title': 'පාඨමාලාවේ නම',
        'score (%)': 'ලකුණු (%)',
        'retake action': 'RETAKE ක්‍රියාව',
        'allow retake': 'Retake අවසර දෙන්න',
        'retake allowed': 'Retake අවසර ලබා දී ඇත',
        'no completion records found in this scope.': 'මෙම විෂය පථය තුළ සම්පූර්ණ කළ වාර්තා හමු නොවීය.',
        'change super admin password': 'සුපිරි පරිපාලක මුරපදය වෙනස් කරන්න',
        'current password': 'වත්මන් මුරපදය',
        'new password (min 8 chars)': 'නව මුරපදය (අවම අක්ෂර 8)',
        'new password': 'නව මුරපදය',
        'confirm new password': 'නව මුරපදය තහවුරු කරන්න',
        'enter current password': 'වත්මන් මුරපදය ඇතුළත් කරන්න',
        'enter your current password': 'ඔබේ වත්මන් මුරපදය ඇතුළත් කරන්න',
        'enter new password': 'නව මුරපදය ඇතුළත් කරන්න',
        'update password': 'මුරපදය යාවත්කාලීන කරන්න',
        'handover super admin role': 'සුපිරි පරිපාලක තනතුර පවරන්න',
        'super admin role handover': 'සුපිරි පරිපාලක තනතුර පැවරීම',
        'select a registered admin in your department scope to promote and transfer super admin credentials.': 'සුපිරි පරිපාලක තනතුර පැවරීමට ඔබේ දෙපාර්තමේන්තුවේ ලියාපදිංචි පරිපාලකයෙකු තෝරන්න.',
        'target admin': 'පැවරිය යුතු පරිපාලක',
        'select an admin': 'පරිපාලකයෙකු තෝරන්න',
        'confirm your password': 'ඔබේ මුරපදය තහවුරු කරන්න',
        'confirm handover': 'පැවරීම තහවුරු කරන්න',
        'role': 'තනතුර',
        'name': 'නම',
        'email': 'විද්‍යුත් තැපෑල',

        // Admin & QAT Dashboards
        'my created courses': 'මම නිර්මාණය කළ පාඨමාලා',
        'my enrolled qats': 'ලියාපදිංචි QAT සාමාජිකයින්',
        'total completions': 'මුළු සම්පූර්ණ කිරීම්',
        'average quiz score': 'සාමාන්‍ය Quiz ලකුණු',
        'my courses status': 'මගේ පාඨමාලා තත්ත්වය',
        '+ add new course': '+ නව පාඨමාලාවක් එක් කරන්න',
        'course name': 'පාඨමාලාවේ නම',
        'created date': 'නිර්මාණය කළ දිනය',
        'my qats completed': 'සම්පූර්ණ කළ QAT ගණන',
        'loading courses...': 'පාඨමාලා පූරණය වෙමින්...',
        'my qats performance & scores': 'මගේ QAT සාමාජිකයින්ගේ ප්‍රතිඵල සහ ලකුණු',
        'filter by qat g id': 'QAT G ID අනුව පෙරන්න',
        'filter by course id': 'පාඨමාලා ID අනුව පෙරන්න',
        'all my qat g ids': 'මගේ සියලුම QAT G ID',
        'all my course ids': 'මගේ සියලුම පාඨමාලා ID',
        'score': 'ලකුණු',
        'result': 'ප්‍රතිඵලය',
        'attempts': 'උත්සාහයන්',
        'completed on': 'සම්පූර්ණ කළ දිනය',
        'loading performance data...': 'ප්‍රතිඵල දත්ත පූරණය වෙමින්...',
        'available courses': 'ඇති පාඨමාලා',
        'average score': 'සාමාන්‍ය ලකුණු',
        'my completed courses': 'මම සම්පූර්ණ කළ පාඨමාලා',
        'go to courses': 'පාඨමාලා වෙත යන්න',
        'no completed courses yet.': 'තවමත් සම්පූර්ණ කළ පාඨමාලා නොමැත.',

        // Admin Register & Details
        'admin register': 'පරිපාලක ලියාපදිංචිය',
        'register a new department admin into the system with unique credentials.': 'අනන්‍ය තොරතුරු සහිතව නව දෙපාර්තමේන්තු පරිපාලකයෙකු පද්ධතියට ලියාපදිංචි කරන්න.',
        'user name': 'පරිශීලක නාමය (Username)',
        'admin name': 'පරිපාලකගේ නම',
        'qat name': 'QAT නම',
        'full name': 'සම්පූර්ණ නම',
        'email address': 'විද්‍යුත් තැපැල් ලිපිනය',
        'office mail address': 'කාර්යාල විද්‍යුත් තැපැල් ලිපිනය',
        'contact number': 'දුරකථන අංකය',
        'telephone number': 'දුරකථන අංකය',
        'phone number': 'දුරකථන අංකය',
        'contact': 'සම්බන්ධතා',
        'company join date': 'සේවයට එක්වූ දිනය',
        'join date': 'ලියාපදිංචි දිනය',
        'password': 'මුරපදය',
        'confirm password': 'මුරපදය තහවුරු කරන්න',
        'register admin': 'පරිපාලක ලියාපදිංචි කරන්න',
        'admin details management': 'පරිපාලක විස්තර කළමනාකරණය',
        'manage admin details and course statistics in the system': 'පද්ධතියේ පරිපාලක විස්තර සහ පාඨමාලා දත්ත කළමනාකරණය කරන්න',
        'add new admin': 'නව පරිපාලකයෙකු එක් කරන්න',
        'total admins registered': 'ලියාපදිංචි මුළු පරිපාලකයින්',
        'total courses created by admins': 'පරිපාලකයින් සෑදූ මුළු පාඨමාලා',
        'registered admins list': 'ලියාපදිංචි පරිපාලක ලැයිස්තුව',
        'courses created list': 'නිර්මාණය කළ පාඨමාලා ලැයිස්තුව',
        'loading admins from database...': 'දත්ත ගබඩාවෙන් පරිපාලක විස්තර පූරණය වෙමින්...',
        'no admins registered yet in database.': 'තවමත් පරිපාලකයින් ලියාපදිංචි වී නොමැත.',
        'no courses available.': 'පාඨමාලා කිසිවක් නොමැත.',
        'failed to load admin list.': 'පරිපාලක ලැයිස්තුව පූරණය අසාර්ථක විය.',

        // QAT Details
        'qat details management': 'QAT විස්තර කළමනාකරණය',
        'manage qat details, account access, and course statistics': 'QAT විස්තර, ගිණුම් ප්‍රවේශය සහ පාඨමාලා සංඛ්‍යාලේඛන කළමනාකරණය කරන්න',
        'add new qat': 'නව QAT කෙනෙකු එක් කරන්න',
        'total qat registered': 'ලියාපදිංචි මුළු QAT ගණන',
        'total completed courses': 'සම්පූර්ණ කළ මුළු පාඨමාලා',
        'registered qat list': 'ලියාපදිංචි QAT ලැයිස්තුව',
        'qat complete courses details': 'QAT සම්පූර්ණ කළ පාඨමාලා විස්තර',
        'course starting date': 'ආරම්භ කළ දිනය',
        'course complete date': 'සම්පූර්ණ කළ දිනය',
        'loading qat details from supabase...': 'QAT විස්තර පූරණය වෙමින්...',
        'no qats registered yet in database.': 'තවමත් QAT සාමාජිකයින් ලියාපදිංචි වී නොමැත.',
        'loading completed courses...': 'සම්පූර්ණ කළ පාඨමාලා පූරණය වෙමින්...',
        'no completed courses recorded yet.': 'තවමත් සම්පූර්ණ කළ පාඨමාලා වාර්තා වී නොමැත.',

        // Course Add, View & Learning Flow
        'add course': 'පාඨමාලාව එක් කරන්න',
        'fill out the fields below to register a new course into the system.': 'නව පාඨමාලාවක් පද්ධතියට එක් කිරීමට පහත තොරතුරු සම්පූර්ණ කරන්න.',
        'course category': 'පාඨමාලා ප්‍රවර්ගය',
        'select category': 'ප්‍රවර්ගය තෝරන්න',
        'lesson configuration': 'පාඩම් සැකසුම',
        'lesson title': 'පාඩමේ නම',
        'learning format': 'ඉගෙනුම් මාධ්‍යය',
        'select format': 'මාධ්‍යය තෝරන්න',
        'all (video + pdf)': 'සියල්ල (වීඩියෝ + PDF)',
        'video only': 'වීඩියෝ පමණි',
        'pdf only': 'PDF පමණි',
        'upload video (mp4 / webm)': 'වීඩියෝව උඩුගත කරන්න (MP4 / WebM)',
        'upload pdf document': 'PDF ලේඛනය උඩුගත කරන්න',
        'configure 3 pause points (5 questions per pause)': 'නැවතුම් ස්ථාන 3 සකසන්න (එකකට ප්‍රශ්න 5 බැගින්)',
        'final mcq assessment quiz': 'අවසාන MCQ ඇගයීම් ප්‍රශ්නාවලිය',
        '+ add question': '+ ප්‍රශ්නයක් එක් කරන්න',
        'pass mark (%)': 'සමත් වීමේ ලකුණු (%)',
        'marks / question': 'ප්‍රශ්නයකට ලකුණු',
        'apply all': 'සැමට යොදන්න',
        'submit course': 'පාඨමාලාව සුරකින්න',
        'select a course to view details and start learning.': 'විස්තර බලා ඉගෙනීම ආරම්භ කිරීමට පාඨමාලාවක් තෝරන්න.',
        'copy shareable link for qat': 'QAT සඳහා Share Link එක පිටපත් කරන්න',
        'no courses available for this department.': 'මෙම දෙපාර්තමේන්තුව සඳහා පාඨමාලා නොමැත.',
        'start learning →': 'ඉගෙනීම අරඹන්න →',
        'next →': 'ඊළඟ →',
        '← back': '← ආපසු',
        'submit quiz ✓': 'Quiz Submit කරන්න ✓',
        'mark video watched ✓': 'වීඩියෝව නැරඹූ බව සලකුණු කරන්න ✓',
        'watched ✓': 'නරඹා අවසන් ✓',
        'video completed ✓': 'වීඩියෝව සම්පූර්ණයි ✓',
        'final assessment quiz': 'අවසාන ඇගයීම් ප්‍රශ්නාවලිය',
        'submit answer': 'පිළිතුර යවන්න',
        'congratulations, you passed!': 'සුබ පැතුම්, ඔබ සමත් වුණා!',
        'try again': 'නැවත උත්සාහ කරන්න',
        'back to courses': 'පාඨමාලා වෙත ආපසු',
        'go to dashboard': 'උපකරණ පුවරුවට යන්න',
        'loading course...': 'පාඨමාලාව පූරණය වෙමින්...',

        // Profile, Settings, Data Management
        'profile': 'පැතිකඩ',
        'profile picture': 'පැතිකඩ ඡායාරූපය',
        'upload new picture': 'නව ඡායාරූපයක් උඩුගත කරන්න',
        'date of birth': 'උපන් දිනය',
        'nic': 'ජාතික හැඳුනුම්පත් අංකය',
        'update profile': 'පැතිකඩ යාවත්කාලීන කරන්න',
        'settings': 'සැකසුම්',
        'privacy settings': 'පෞද්ගලිකත්ව සැකසුම්',
        'show online status': 'Online තත්ත්වය පෙන්වන්න',
        'public (everyone can see)': 'පොදු (සැමට පෙනේ)',
        'private (only me)': 'පෞද්ගලික (මට පමණි)',
        'help & support / feedback': 'සහය සහ ප්‍රතිපෝෂණ',
        'report a bug / error': 'දෝෂයක් වාර්තා කරන්න',
        'system feedback / suggestion': 'පද්ධති යෝජනා / අදහස්',
        'support ticket (general help)': 'සහය ඉල්ලීම',
        'data management': 'දත්ත කළමනාකරණය',
        'backup database, bulk import data, and manage system logs': 'දත්ත ගබඩාව Backup කරන්න, CSV දත්ත ඇතුළත් කරන්න සහ System Logs කළමනාකරණය කරන්න',
        'supabase connection status': 'Supabase සම්බන්ධතා තත්ත්වය',
        'connected to supabase': 'Supabase වෙත සම්බන්ධයි',
        'full database backup & restore': 'සම්පූර්ණ දත්ත Backup සහ Restore',
        'download complete database backup or restore from a json file.': 'සම්පූර්ණ දත්ත ගබඩාව JSON ගොනුවක් ලෙස බාගත කිරීම හෝ යළි පිහිටුවීම.',
        'bulk import data (csv upload to supabase)': 'දත්ත විශාල ප්‍රමාණයක් එක් කිරීම (CSV Upload)',
        'select target table and upload a csv file to import records directly into supabase.': 'අදාළ Table එක තෝරා CSV ගොනුවක් Supabase වෙත උඩුගත කරන්න.',
        'target table': 'අදාළ Table එක',
        'select csv file': 'CSV ගොනුව තෝරන්න',
        'system activity logs (audit trail)': 'පද්ධති ක්‍රියාකාරකම් වාර්තා (Audit Trail)',
        'recent data management actions performed.': 'මෑතකදී සිදු කළ දත්ත කළමනාකරණ ක්‍රියාවන්.',
        'clear logs': 'වාර්තා මකන්න',
        'timestamp': 'වේලාව',
        'user': 'පරිශීලක',
        'details': 'විස්තර'
    };

    function translateString(raw) {
        if (!raw || raw.length > 260) return raw;
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        const core = raw.trim().replace(/\s+/g, ' ');
        if (!core) return raw;

        const exact = SI_EXACT[core.toLowerCase()];
        if (exact) return lead + exact + trail;

        // Pattern translations for dynamic strings
        if (/^Scope:\s*All Departments/i.test(core)) {
            return lead + 'විෂය පථය: සියලුම දෙපාර්තමේන්තු (සාමාන්‍ය සුපිරි පරිපාලක)' + trail;
        }
        let m;
        if ((m = core.match(/^Scope:\s*(.+?)\s*Department$/i))) {
            return lead + `විෂය පථය: ${m[1]} දෙපාර්තමේන්තුව` + trail;
        }
        if ((m = core.match(/^Scope:\s*(.+)$/i))) {
            return lead + `විෂය පථය: ${m[1]}` + trail;
        }
        if ((m = core.match(/^Department:\s*(.+)$/i))) {
            return lead + `දෙපාර්තමේන්තුව: ${m[1]}` + trail;
        }
        if ((m = core.match(/^Welcome back,\s*(.+)$/i))) {
            return lead + `නැවත සාදරයෙන් පිළිගනිමු, ${m[1]}` + trail;
        }
        if ((m = core.match(/^(\d+)\s+Completed$/i))) {
            return lead + `${m[1]} සම්පූර්ණයි` + trail;
        }
        if ((m = core.match(/^(\d+)\s*min ago$/i))) {
            return lead + `මිනිත්තු ${m[1]} කට පෙර` + trail;
        }
        if ((m = core.match(/^Step\s+(\d+)\s*\/\s*(\d+)$/i))) {
            return lead + `පියවර ${m[1]} / ${m[2]}` + trail;
        }
        if ((m = core.match(/^⏱️\s*Time Left:\s*(.+)$/i))) {
            return lead + `⏱️ ඉතිරි කාලය: ${m[1]}` + trail;
        }
        if ((m = core.match(/^Time Limit:\s*(.+)$/i))) {
            return lead + `කාල සීමාව: ${m[1]}` + trail;
        }
        if ((m = core.match(/^Format:\s*(.+)$/i))) {
            return lead + `මාධ්‍යය: ${m[1]}` + trail;
        }
        if ((m = core.match(/^Lesson:\s*(.+)$/i))) {
            return lead + `පාඩම: ${m[1]}` + trail;
        }
        if ((m = core.match(/^Created by Admin:\s*(.+)$/i))) {
            return lead + `නිර්මාණය කළ පරිපාලක: ${m[1]}` + trail;
        }
        if ((m = core.match(/^Pass Mark:\s*(.+)$/i))) {
            return lead + `සමත් ලකුණු: ${m[1]}` + trail;
        }
        return raw;
    }

    let isTranslating = false;
    let translationObserver = null;

    function translateRoot(root) {
        if (getLang() !== 'si' || !root) return;
        isTranslating = true;
        try {
            if (document.title && / - GSS LMS$/i.test(document.title)) {
                const base = document.title.replace(/ - GSS LMS$/i, '').trim().toLowerCase();
                if (SI_EXACT[base]) document.title = `${SI_EXACT[base]} - GSS LMS`;
            }

            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    const p = node.parentElement;
                    if (!p) return NodeFilter.FILTER_REJECT;
                    const tag = p.tagName;
                    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'CODE') {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (p.closest && p.closest('#sidebar-nav')) return NodeFilter.FILTER_REJECT;
                    return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                }
            });

            const nodes = [];
            let cur;
            while ((cur = walker.nextNode())) nodes.push(cur);
            for (const n of nodes) {
                const next = translateString(n.nodeValue);
                if (next !== n.nodeValue) n.nodeValue = next;
            }

            if (root.querySelectorAll) {
                root.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(el => {
                    const ph = el.getAttribute('placeholder');
                    const next = translateString(ph);
                    if (next !== ph) el.setAttribute('placeholder', next);
                });
            }
        } finally {
            isTranslating = false;
        }
    }

    function applyTranslations() {
        document.documentElement.lang = getLang();
        if (getLang() !== 'si' || !document.body) return;

        translateRoot(document.body);

        if (!translationObserver && window.MutationObserver) {
            let queued = false;
            translationObserver = new MutationObserver(() => {
                if (isTranslating || queued) return;
                queued = true;
                requestAnimationFrame(() => {
                    queued = false;
                    translateRoot(document.body);
                });
            });
            translationObserver.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyTranslations);
    } else {
        applyTranslations();
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
        applyTranslations,
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
