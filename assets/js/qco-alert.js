// qco-alert.js
// Monitors active QCOs across the application and alerts if they are discarded

(function () {
    let alertInterval = null;
    let currentlyAlertingQCO = null;

    function getActiveQCONumber() {
        // Try to find the active QCO based on common global variables used across different pages
        if (typeof currentQCOId !== 'undefined' && currentQCOId) return currentQCOId;
        if (typeof currentQCONumber !== 'undefined' && currentQCONumber) return currentQCONumber;
        if (typeof qcoId !== 'undefined' && qcoId) return qcoId;
        if (typeof existingQCORef !== 'undefined' && existingQCORef) return existingQCORef.id || existingQCORef.qcoNumber;

        // Try to get from URL params
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('qco')) return urlParams.get('qco');
        if (urlParams.has('id')) return urlParams.get('id');

        return null;
    }

    async function checkQCOStatus() {
        console.log('[qco-alert] checkQCOStatus triggered.');
        const qcoNumber = getActiveQCONumber();
        console.log('[qco-alert] getActiveQCONumber returned:', qcoNumber);
        if (!qcoNumber) return;

        try {
            // Check Firebase if available — only need db to be initialized
            const hasDb = typeof db !== 'undefined' && db !== null;

            console.log('[qco-alert] hasDb:', hasDb);

            if (hasDb) {
                console.log('[qco-alert] Querying Firebase for QCO:', qcoNumber);
                const doc = await db.collection('changeovers').doc(qcoNumber).get();
                console.log('[qco-alert] doc.exists?', doc.exists);
                if (doc.exists) {
                    const data = doc.data();
                    console.log('[qco-alert] data.status:', data.status);
                    if (data.status === 'discarded') {
                        triggerAlert(qcoNumber, data.movedTo);
                    }
                }
            } else {
                console.log('[qco-alert] Falling back to localStorage...');
                // Fallback to localStorage check if Firebase is not connected or db is not initialized
                const localData = localStorage.getItem('changeovers');
                if (localData) {
                    const changeovers = JSON.parse(localData);
                    const qco = changeovers.find(c => c.qcoNumber === qcoNumber || c.id === qcoNumber);
                    if (qco) {
                        console.log('[qco-alert] Local QCO found. Status:', qco.status);
                    }
                    if (qco && qco.status === 'discarded') {
                        triggerAlert(qcoNumber, qco.movedTo);
                    }
                }
            }
        } catch (error) {
            console.error("[qco-alert] Error checking QCO discarded status:", error);
        }
    }

    function triggerAlert(discardedQco, newQco) {
        // Prevent stacking alerts
        if (Swal.isVisible() && currentlyAlertingQCO === discardedQco) return;

        currentlyAlertingQCO = discardedQco;

        let redirectHtml = '';
        if (newQco) {
            redirectHtml = `<p class="mt-4 text-sm font-bold text-gray-700">This has been moved to: <br><span class="text-blue-600 border border-blue-200 bg-blue-50 px-2 py-1 rounded inline-block mt-1">${newQco}</span></p>`;
        }

        Swal.fire({
            icon: 'error',
            title: 'Discarded Changeover',
            html: `<p>You are viewing a discarded QCO <b>(${discardedQco})</b>. This record is no longer active.</p>${redirectHtml}`,
            confirmButtonText: newQco ? 'Go to New QCO' : 'I Understand',
            confirmButtonColor: newQco ? '#2563eb' : '#ef4444',
            allowOutsideClick: false,
            backdrop: `
                rgba(0,0,123,0.4)
                left top
                no-repeat
            `
        }).then((result) => {
            currentlyAlertingQCO = null;
            if (result.isConfirmed && newQco) {
                if (typeof window.handleExistingQCOSelect === 'function') {
                    // creation.html
                    const selectEl = document.getElementById('existingQCOSelect');
                    if (selectEl) selectEl.value = newQco;
                    window.handleExistingQCOSelect(newQco);
                } else if (typeof window.handleQCOChange === 'function') {
                    // All other pages that have handleQCOChange
                    const selectEl = document.getElementById('qcoSelector');
                    if (selectEl) selectEl.value = newQco;

                    // Some pages expect a second saveToStorage parameter, others don't.
                    // Passing `true` as second argument is harmless for those that don't expect it.
                    window.handleQCOChange(newQco, true);
                } else {
                    // Fallback for pages without JS selection handlers (e.g., pure URL driven pages)
                    const urlParams = new URLSearchParams(window.location.search);
                    if (urlParams.has('qco')) urlParams.set('qco', newQco);
                    if (urlParams.has('id')) urlParams.set('id', newQco);

                    if (urlParams.has('qco') || urlParams.has('id')) {
                        window.location.search = urlParams.toString();
                    } else {
                        // If no params, try to set local storage and reload as a very last resort
                        localStorage.setItem('currentQCO', newQco);
                        window.location.reload();
                    }
                }
            }
        });
    }

    // ==========================================
    // AUTOMATIC CHECKLIST REMINDER (≤24 hours)
    // Runs on ANY page load across the entire app
    // ==========================================
    let checklistReminderRunning = false;

    function getBackendUrl() {
        if (typeof BACKEND_URL !== 'undefined') return BACKEND_URL;
        if (typeof backendUrl !== 'undefined') return backendUrl;
        return (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
            ? 'http://localhost:3000'
            : window.location.origin;
    }

    /**
     * Calculate checklist completion from a departments array stored in Firestore.
     * Returns { totalItems, completedItems, percent, incompleteDepts }
     */
    function calculateChecklistProgress(departments) {
        if (!departments || !Array.isArray(departments)) {
            return { totalItems: 0, completedItems: 0, percent: 0, incompleteDepts: [] };
        }

        let totalItems = 0;
        let completedItems = 0;
        const incompleteDepts = [];

        departments.forEach(dept => {
            let deptTotal = 0;
            let deptDone = 0;

            (dept.stages || []).forEach(stage => {
                (stage.items || []).forEach(item => {
                    deptTotal++;
                    totalItems++;
                    if (item.completed) {
                        deptDone++;
                        completedItems++;
                    }
                });
            });

            const deptPercent = deptTotal === 0 ? 100 : Math.round((deptDone / deptTotal) * 100);
            if (deptPercent < 100) {
                incompleteDepts.push({
                    name: dept.name || dept.id,
                    progress: deptPercent,
                    completedItems: deptDone,
                    totalItems: deptTotal
                });
            }
        });

        const percent = totalItems === 0 ? 100 : Math.round((completedItems / totalItems) * 100);
        return { totalItems, completedItems, percent, incompleteDepts };
    }

    /**
     * Build a professional HTML email body for the checklist reminder.
     */
    function buildReminderEmailHTML(qcoData, qcoId, progress) {
        const qcoNumber = qcoData.qcoNumber || qcoId || '—';
        const line = qcoData.lineNumber || qcoData.line || '—';
        const supervisor = qcoData.supervisorName || qcoData.supervisor || '—';
        const currentStyle = qcoData.currentStyle || '—';
        const upcomingStyle = qcoData.upcomingStyle || '—';

        let dateStr = '—';
        if (qcoData.scheduledDate) {
            const d = qcoData.scheduledDate.toDate ? qcoData.scheduledDate.toDate() : new Date(qcoData.scheduledDate);
            dateStr = d.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
        }

        const barRows = progress.incompleteDepts.map(dept => {
            const pct = dept.progress;
            const barColor = pct < 30 ? '#ef4444' : pct < 60 ? '#f59e0b' : '#3b82f6';
            return `
                <tr>
                    <td style="padding: 8px 12px; font-weight: 600; color: #374151; width: 140px; border-bottom: 1px solid #f1f5f9;">${dept.name}</td>
                    <td style="padding: 8px 12px; border-bottom: 1px solid #f1f5f9;">
                        <div style="background: #f1f5f9; border-radius: 999px; height: 22px; width: 100%; position: relative; overflow: hidden;">
                            <div style="background: ${barColor}; height: 100%; border-radius: 999px; width: ${pct}%;"></div>
                            <span style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 700; color: #1e293b;">${pct}%</span>
                        </div>
                    </td>
                    <td style="padding: 8px 12px; text-align: center; font-size: 12px; color: #64748b; border-bottom: 1px solid #f1f5f9;">${dept.completedItems}/${dept.totalItems}</td>
                </tr>`;
        }).join('');

        return `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #374151;">
                <div style="background: linear-gradient(135deg, #ef4444, #f59e0b); padding: 20px 24px; border-radius: 12px; margin-bottom: 24px;">
                    <h2 style="margin: 0; color: white; font-size: 18px;">⏰ 24-Hour Checklist Reminder</h2>
                    <p style="margin: 4px 0 0; color: rgba(255,255,255,0.9); font-size: 13px;">Changeover is TOMORROW — Departments below 100% completion</p>
                </div>

                <p>Dear Team,</p>
                <p>This is an <strong>automated reminder</strong> that the following changeover is scheduled within the next <strong>24 hours</strong>, and the departmental checklists are <strong>NOT yet 100% complete</strong> (currently at <strong>${progress.percent}%</strong>).</p>

                <h3 style="color: #dc2626; border-bottom: 2px solid rgba(220,38,38,0.3); padding-bottom: 8px; margin-top: 24px; margin-bottom: 16px;">CHANGEOVER DETAILS</h3>
                <table style="width: 100%; margin-bottom: 20px;">
                    <tr><td style="width: 150px; padding: 4px 0;"><strong>QCO Number:</strong></td><td style="padding: 4px 0;">${qcoNumber}</td></tr>
                    <tr><td style="padding: 4px 0;"><strong>Line:</strong></td><td style="padding: 4px 0;">${line}</td></tr>
                    <tr><td style="padding: 4px 0;"><strong>Supervisor:</strong></td><td style="padding: 4px 0;">${supervisor}</td></tr>
                    <tr><td style="padding: 4px 0;"><strong>Changeover Date:</strong></td><td style="padding: 4px 0; font-weight: bold; color: #dc2626;">${dateStr}</td></tr>
                    <tr><td style="padding: 4px 0;"><strong>Current Style:</strong></td><td style="padding: 4px 0;">${currentStyle}</td></tr>
                    <tr><td style="padding: 4px 0;"><strong>Upcoming Style:</strong></td><td style="padding: 4px 0;">${upcomingStyle}</td></tr>
                    <tr><td style="padding: 4px 0;"><strong>Overall Checklist:</strong></td><td style="padding: 4px 0; font-weight: bold; color: ${progress.percent < 50 ? '#ef4444' : '#f59e0b'};">${progress.percent}% (${progress.completedItems}/${progress.totalItems})</td></tr>
                </table>

                <h3 style="color: #dc2626; border-bottom: 2px solid rgba(220,38,38,0.3); padding-bottom: 8px; margin-top: 24px; margin-bottom: 16px;">INCOMPLETE DEPARTMENTS</h3>
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                    <thead>
                        <tr style="background: #f8fafc;">
                            <th style="text-align: left; padding: 10px 12px; font-size: 12px; color: #64748b; text-transform: uppercase; border-bottom: 2px solid #e2e8f0;">Department</th>
                            <th style="text-align: left; padding: 10px 12px; font-size: 12px; color: #64748b; text-transform: uppercase; border-bottom: 2px solid #e2e8f0;">Progress</th>
                            <th style="text-align: center; padding: 10px 12px; font-size: 12px; color: #64748b; text-transform: uppercase; border-bottom: 2px solid #e2e8f0;">Items</th>
                        </tr>
                    </thead>
                    <tbody>${barRows}</tbody>
                </table>

                <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 16px 20px; border-radius: 0 8px 8px 0; margin-bottom: 24px;">
                    <p style="margin: 0; color: #991b1b; font-weight: 600;">
                        The changeover is scheduled for <strong>${dateStr}</strong>. Please ensure all remaining checklist items are completed and signed off immediately.
                    </p>
                </div>

                <p>Thank you</p>

                <div style="margin-top: 40px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
                    <p>Regards,<br>
                    <strong>Manufacturing Excellence Department</strong><br>
                    Sidney Apparels LLC, QVJ</p>
                    <p style="font-size: 0.75rem; color: #9ca3af;">
                        This email was automatically generated by the Changeover Checklist Reminder System (24h auto-check)
                    </p>
                </div>
            </div>`;
    }

    /**
     * Runs on every page load. Scans all scheduled changeovers.
     * If any are ≤24 hours away AND their checklist is not 100% complete,
     * sends an automatic reminder email (once per schedule).
     */
    async function checkAndSendChecklistReminders() {
        if (checklistReminderRunning) return;
        checklistReminderRunning = true;

        try {
            const hasDb = typeof db !== 'undefined' && db !== null;
            if (!hasDb) {
                console.log('[checklist-reminder] No DB connection yet, skipping.');
                return;
            }

            const now = new Date();
            const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

            console.log('[checklist-reminder] Checking for changeovers within 24h...');

            // Query all changeovers that have a scheduled date
            const snapshot = await db.collection('changeovers')
                .where('hasSchedule', '==', true)
                .orderBy('emailScheduledFor', 'asc')
                .limit(50)
                .get();

            let sentCount = 0;

            for (const doc of snapshot.docs) {
                const qco = doc.data();
                const qcoId = doc.id;

                // Skip completed or discarded
                if (qco.status === 'completed' || qco.status === 'discarded') continue;

                // Check if scheduledDate is within the next 24 hours
                if (!qco.scheduledDate) continue;
                const scheduledDate = qco.scheduledDate.toDate
                    ? qco.scheduledDate.toDate()
                    : new Date(qco.scheduledDate);

                // Must be in the future but within 24h
                if (scheduledDate <= now || scheduledDate > in24h) continue;

                // Check if we already sent a reminder for this schedule
                if (qco.checklistAutoReminderSent) {
                    const lastSent = qco.checklistAutoReminderSent.toDate
                        ? qco.checklistAutoReminderSent.toDate()
                        : new Date(qco.checklistAutoReminderSent);
                    // If sent within the last 20 hours, skip (prevents re-sends on each page load)
                    if ((now.getTime() - lastSent.getTime()) < 20 * 60 * 60 * 1000) {
                        console.log(`[checklist-reminder] Already sent for ${qcoId}, skipping.`);
                        continue;
                    }
                }

                // Check checklist completion
                const progress = calculateChecklistProgress(qco.departments);
                if (progress.percent >= 100) {
                    console.log(`[checklist-reminder] ${qcoId} is 100% complete, no reminder needed.`);
                    continue;
                }

                // Build and send the email
                console.log(`[checklist-reminder] Sending reminder for ${qcoId} (${progress.percent}% complete, due: ${scheduledDate.toLocaleString()})`);

                const html = buildReminderEmailHTML(qco, qcoId, progress);
                const qcoNumber = qco.qcoNumber || qcoId;
                const line = qco.lineNumber || '—';
                const subject = `⏰ 24h REMINDER: Checklist Incomplete — QCO ${qcoNumber} Line ${line} (${progress.percent}%)`;

                const recipients = 'shantanu.guin281203@gmail.com';
                const cc = 'sampreeti6404@gmail.com';

                try {
                    const response = await fetch(`${getBackendUrl()}/api/send-email`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            from: 'management.trainee@sidneyapparels.com',
                            to: recipients,
                            cc: cc,
                            subject: subject,
                            html: html,
                            text: `Checklist Reminder: QCO ${qcoNumber} is ${progress.percent}% complete with less than 24 hours remaining.`,
                            accountType: 'creation'
                        })
                    });

                    if (response.ok) {
                        // Mark as sent in Firebase
                        await db.collection('changeovers').doc(qcoId).update({
                            checklistAutoReminderSent: firebase.firestore.FieldValue.serverTimestamp(),
                            checklistAutoReminderPercent: progress.percent
                        });
                        sentCount++;
                        console.log(`[checklist-reminder] ✅ Email sent for ${qcoId}`);
                    } else {
                        const errData = await response.json().catch(() => ({}));
                        console.error(`[checklist-reminder] ❌ Email failed for ${qcoId}:`, errData);
                    }
                } catch (emailErr) {
                    console.error(`[checklist-reminder] ❌ Network error for ${qcoId}:`, emailErr);
                }
            }

            if (sentCount > 0) {
                console.log(`[checklist-reminder] Done: ${sentCount} reminder(s) sent.`);
            } else {
                console.log('[checklist-reminder] No reminders needed at this time.');
            }

        } catch (error) {
            console.error('[checklist-reminder] Error:', error);
        } finally {
            checklistReminderRunning = false;
        }
    }

    // Start monitoring only when document is ready
    function initQCOAlert() {
        // Initial check after 2 seconds to allow pages to load data
        setTimeout(checkQCOStatus, 2000);

        // Check every 10 seconds
        alertInterval = setInterval(checkQCOStatus, 10000);

        // Checklist reminder check — run 3 seconds after page load (once)
        setTimeout(checkAndSendChecklistReminders, 3000);
    }

    // Export so other pages can trigger it manually
    window.checkQCOStatus = checkQCOStatus;
    window.checkAndSendChecklistReminders = checkAndSendChecklistReminders;

    // Initialize when DOM is available
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initQCOAlert);
    } else {
        initQCOAlert();
    }
})();
