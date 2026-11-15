/* ==========================================================================
   lms-auth.js : Login (username / email / G ID + password) via Supabase DB.
   Load order (index.html): supabase-js CDN -> lms-core.js -> lms-auth.js -> login.js
   ========================================================================== */
(function () {
    'use strict';

    const KEYS = { super_admin: 'currentSuperAdmin', admin: 'currentAdmin', qat: 'currentQat' };
    const isActive = u => !u.status || String(u.status).toLowerCase() === 'active';

    function remember(role, userData) {
        Object.values(KEYS).forEach(k => localStorage.removeItem(k));
        localStorage.setItem(KEYS[role], JSON.stringify(userData));
        localStorage.setItem('currentLmsUserRole', role);
        sessionStorage.setItem('lms_online_since', String(Date.now()));
    }

    const likeEsc = s => String(s).replace(/[\\%_]/g, '\\$&');

    async function find(table, columns, value) {
        for (const col of columns) {
            const { data, error } = await LMS.db.from(table).select('*').ilike(col, likeEsc(value)).limit(1);
            if (error) throw error;
            if (data && data.length) return data[0];
        }
        return null;
    }

    const TABLES = [
        { role: 'super_admin', table: 'super_admin', cols: ['user_name', 'biz_mail', 'super_admin_g_id'] },
        { role: 'admin',       table: 'admins',      cols: ['user_name', 'email', 'admin_g_id'] },
        { role: 'qat',         table: 'qats',        cols: ['user_name', 'email', 'qat_g_id'] }
    ];

    async function signIn(identifier, password) {
        const id = String(identifier).trim();
        const pwd = String(password).trim();
        if (!id || !pwd) throw new Error('Username සහ password ඇතුල් කරන්න.');

        for (const t of TABLES) {
            const user = await find(t.table, t.cols, id);
            if (!user) continue;
            if (String(user.password ?? '').trim() !== pwd) {
                throw new Error('Invalid username/email or password.');
            }
            if (!isActive(user)) {
                const st = String(user.status).toLowerCase();
                throw new Error(
                    st === 'pending'
                        ? 'ඔබේ account එක තවම අනුමත වී නැහැ. Admin ගේ අනුමැතිය බලාපොරොත්තුවෙන්.'
                        : 'මේ account එක active නැහැ. Admin ට කතා කරන්න.'
                );
            }
            remember(t.role, user);
            return { role: t.role, user };
        }
        throw new Error('Invalid username/email or password.');
    }

    window.addEventListener('pageshow', e => { if (e.persisted) window.location.reload(); });
    Object.assign(window.LMS, { signIn });
})();