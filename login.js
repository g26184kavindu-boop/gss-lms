/* login.js : index.html login logic (including superman bootstrap & safe redirect handling) */
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const toggle = (el, show) => { if (el) el.classList.toggle('hidden', !show); };
    const isSafe = u => !!u && !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//');

    $('login-btn')?.addEventListener('click', () => toggle($('login-modal'), true));
    $('close-login-modal')?.addEventListener('click', () => toggle($('login-modal'), false));
    $('signup-btn')?.addEventListener('click', () => toggle($('signup-modal'), true));
    $('close-modal')?.addEventListener('click', () => toggle($('signup-modal'), false));

    window.addEventListener('click', e => {
        if (e.target === $('login-modal')) toggle($('login-modal'), false);
        if (e.target === $('signup-modal')) toggle($('signup-modal'), false);
    });

    const redirectParam = new URLSearchParams(location.search).get('redirect');
    if (redirectParam !== null) {
        toggle($('login-modal'), true);
        const qatLink = $('signup-qat-link');
        if (qatLink && isSafe(redirectParam)) {
            qatLink.href = `qat-register.html?redirect=${encodeURIComponent(redirectParam)}`;
        }
    }

    const googleBtn = $('google-login-btn');
    if (googleBtn) {
        googleBtn.addEventListener('click', e => {
            e.preventDefault();
            alert('Please sign in using your assigned GSS Username / Email / G ID and Password.');
        });
    }

    $('login-form')?.addEventListener('submit', async e => {
        e.preventDefault();
        const btn = $('login-submit-btn') || e.target.querySelector('button[type="submit"]');
        const identifier = $('login-username').value.trim();
        const password = $('login-password').value;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Signing in...';
        }
        try {
            if (identifier === 'superman') {
                const { data: ok, error } = await LMS.db.rpc('check_bootstrap', { p_user: identifier, p_pass: password });
                if (error) throw error;
                if (ok === true) {
                    sessionStorage.setItem('lms_bootstrap', JSON.stringify({ u: identifier, p: password }));
                    window.location.href = 'super-admin-register.html';
                    return;
                }
                throw new Error('Invalid username/email or password.');
            }

            const p = await LMS.signIn(identifier, password);
            if (isSafe(redirectParam) && p.role === 'qat') {
                window.location.href = redirectParam;
            } else if (isSafe(redirectParam) && redirectParam.toLowerCase().includes('course-learning-flow')) {
                window.location.href = redirectParam;
            } else {
                window.location.href = LMS.HOME[p.role] || 'admin-dashboard.html';
            }
        } catch (err) {
            alert(err.message || 'Login failed.');
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Login';
            }
        }
    });
})();