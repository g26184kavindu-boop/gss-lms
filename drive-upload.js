/* ==========================================================================
   drive-upload.js : Video upload / delete to company Google Drive via Supabase Edge Function
   Requires lms-core.js to be loaded first.
   ========================================================================== */
(function () {
    'use strict';

    if (!window.LMS) {
        console.error('drive-upload.js: lms-core.js must be loaded first.');
        return;
    }

    const FN_URL = 'https://vdglyvehezapesbrovqp.supabase.co/functions/v1/drive-upload';
    const ANON_KEY = 'sb_publishable_t0AeLmN1tQkQLaH5s968eA_KSeFdTGl';

    function askPassword(message, okLabel) {
        return new Promise(resolve => {
            const o = document.createElement('div');
            o.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-[200] p-4';
            o.setAttribute('role', 'dialog');
            o.setAttribute('aria-modal', 'true');
            o.innerHTML = `<div class="bg-white p-6 rounded-xl shadow-lg max-w-sm w-full space-y-3">
                <p class="text-sm text-stone-700"></p>
                <input type="password" autocomplete="current-password" class="w-full px-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500">
                <div class="flex justify-end gap-2">
                    <button type="button" data-r="0" class="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg text-sm font-semibold">Cancel</button>
                    <button type="button" data-r="1" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold"></button>
                </div></div>`;
            o.querySelector('p').textContent = message;
            o.querySelector('[data-r="1"]').textContent = okLabel || 'OK';
            document.body.appendChild(o);
            const inp = o.querySelector('input');
            inp.focus();
            const done = v => { o.remove(); resolve(v); };
            o.addEventListener('click', e => {
                const b = e.target.closest('button');
                if (b) done(b.dataset.r === '1' ? inp.value : '');
            });
            inp.addEventListener('keydown', e => {
                if (e.key === 'Enter') done(inp.value);
                if (e.key === 'Escape') done('');
            });
        });
    }

    async function call(body) {
        const res = await fetch(FN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
            body: JSON.stringify(body)
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || ('Server error ' + res.status));
        return j;
    }

    function authBody(password) {
        const s = LMS.getSession();
        if (!s || !s.gid) throw new Error('Session ID not found. Please log in again.');
        return { gid: s.gid, password };
    }

    async function uploadVideo(file, opts = {}) {
        const password = await askPassword('Video upload කිරීමට ඔබේ password එක ඇතුල් කරන්න:', 'Upload');
        if (!password) throw new Error('Password not entered (Cancelled)');
        const auth = authBody(password);
        const onProgress = opts.onProgress || (() => {});

        const { uploadUrl } = await call({
            action: 'init', ...auth, name: file.name, size: file.size,
            mimeType: file.type || 'video/mp4', origin: location.origin
        });

        const fileId = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', uploadUrl);
            xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
            xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
            xhr.onload = () => {
                try {
                    const d = JSON.parse(xhr.responseText);
                    if (d.id) resolve(d.id);
                    else reject(new Error('Drive: ' + xhr.responseText.slice(0, 200)));
                } catch (_) {
                    reject(new Error('Upload failed (' + xhr.status + ')'));
                }
            };
            xhr.onerror = () => reject(new Error('Network / CORS error: Unable to upload to Drive.'));
            xhr.send(file);
        });

        await call({ action: 'finish', ...auth, fileId });
        return fileId;
    }

    async function deleteVideo(fileId) {
        const password = await askPassword('Drive එකේ video file එකත් මකන්න ඔබේ password එක ඇතුල් කරන්න (Cancel = video remains in Drive):', 'Delete video');
        if (!password) return false;
        await call({ action: 'delete', ...authBody(password), fileId });
        return true;
    }

    LMS.uploadVideo = uploadVideo;
    LMS.deleteVideo = deleteVideo;
})();