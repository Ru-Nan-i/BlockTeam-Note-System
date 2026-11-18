const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
require('ejs-electron');

let mainWindow;
let sessionToken = null; // 로그인 성공 시 GAS로부터 발급받는 동적 세션 토큰
let currentDoctorId = null;
let currentPatient = null;
let currentUserRole = 'doctor';
let pendingChartSaves = 0; // 클라우드 저장 진행 중 동기화 덮어쓰기 방지 카운터

// ====================================================================
// ★ 1. Google Apps Script(GAS) 웹앱 URL
// ====================================================================
const GAS_URL = 'https://script.google.com/macros/s/AKfycbyCQD7InLa0hzUiJ50k9KixUH03M9zs_pc9ZObisRUBOez82hcZ696rjtXKm8NkJH7Olg/exec';

// ====================================================================
// ★ 2. 메모리 캐시 저장소
// ====================================================================
let localCache = {
    departments: [],
    users: [],
    patients: [],
    charts: [],
    chartsVersion: null,
    patientsVersion: null,
    isLoaded: false
};

// ====================================================================
// ★ 3. GAS 통신용 헬퍼 함수 (동적 세션 토큰 전송)
// ====================================================================
async function requestGAS(action, payload = {}) {
    try {
        const bodyData = {
            action,
            token: sessionToken,
            ...payload
        };

        const response = await fetch(GAS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(bodyData)
        });

        const text = await response.text();

        if (action !== 'ping') {
            console.log(`[GAS] Response [${action}] | Status: ${response.status} | Length: ${text.length}`);
        }

        if (!text || !text.trim()) {
            console.error(`[GAS] Empty response returned [${action}]`);
            return {
                success: false,
                message: `GAS 빈 응답 (HTTP ${response.status})`
            };
        }

        try {
            const result = JSON.parse(text);

            if (!response.ok || result.success === false) {
                console.error(`[GAS] Action failed [${action}]:`, result.message);
            }

            // 세션 만료 시 로그인 화면으로 전환
            if (result && result.code === 'UNAUTHORIZED' && action !== 'login') {
                console.warn('[Auth] Session expired. Redirecting to login screen.');
                sessionToken = null;
                localCache.isLoaded = false;
                localCache.chartsVersion = null;
                localCache.patientsVersion = null;
                if (autoSyncTimer) clearInterval(autoSyncTimer);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.loadURL('file://' + __dirname + '/views/login.ejs');
                }
            }

            return result;

        } catch (jsonError) {
            console.error(`[GAS] JSON parse failed [${action}] / Raw: ${text}`);
            return {
                success: false,
                message: `GAS가 JSON이 아닌 응답을 반환했습니다. HTTP ${response.status}`,
                rawResponse: text
            };
        }

    } catch (error) {
        if (action !== 'ping') {
            console.error(`[GAS] Network error (${action}):`, error);
        }
        return {
            success: false,
            message: error.message || '서버 통신 실패'
        };
    }
}

// ====================================================================
// ★ 4. F5 새로고침용 전체 데이터 캐시 갱신
// ====================================================================
async function loadEverythingToCache() {
    console.log('[Cache] Fetching full data from Drive via GAS...');

    const result = await requestGAS('loadAll');

    if (result.success && result.data) {
        localCache.departments = result.data.departments || [];
        localCache.users = result.data.users || [];
        localCache.patients = result.data.patients || [];
        localCache.charts = result.data.charts || [];
        localCache.chartsVersion = result.chartsVersion || null;
        localCache.patientsVersion = result.patientsVersion || null;
        localCache.isLoaded = true;

        console.log('[Cache] Caching complete. All queries ready.');
        console.log(`[Cache] Depts: ${localCache.departments.length} | Users: ${localCache.users.length} | Items: ${localCache.patients.length} | Charts: ${localCache.charts.length}`);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('cache-loaded');
        }

    } else {
        console.error('[Cache] Data load failed:', result ? result.message : 'No response');
    }
}

// ====================================================================
// ★ 5. 스마트 차등 동기화 (차트 + 포스트잇 버전 동시 체크 + 창 포커스 연동)
// ====================================================================
let autoSyncTimer = null;
let isSyncingNow = false;

async function syncChartsNow() {
    if (!sessionToken || !localCache.isLoaded || isSyncingNow || pendingChartSaves > 0) return;
    isSyncingNow = true;

    try {
        const result = await requestGAS('syncCharts', {
            lastVersion: localCache.chartsVersion,
            lastPatientsVersion: localCache.patientsVersion
        });

        if (result && result.success) {
            if (result.upToDate) {
                return;
            }

            if (pendingChartSaves === 0) {
                // 1) 차팅 기록 변경 반영
                if (result.data) {
                    console.log('[Sync] Chart data changes detected and synced.');
                    localCache.charts = result.data;
                    localCache.chartsVersion = result.version || null;

                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('auto-sync-updated');
                    }
                }

                // 2) 환자/포스트잇 변경 반영
                if (result.patientsData) {
                    console.log('[Sync] Post-it and item metadata synced.');
                    localCache.patients = result.patientsData;
                    localCache.patientsVersion = result.patientsVersion || null;

                    if (currentPatient) {
                        const updated = localCache.patients.find(p => String(p.id) === String(currentPatient.id));
                        if (updated) {
                            currentPatient = updated;
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send('postit-sync-updated', {
                                    patientId: currentPatient.id,
                                    postIt: currentPatient.postIt || ''
                                });
                            }
                        }
                    }
                }
            }
        }
    } catch (err) {
        // 일시적 통신 대기 무시
    } finally {
        isSyncingNow = false;
    }
}

function startAutoSync() {
    if (autoSyncTimer) clearInterval(autoSyncTimer);

    autoSyncTimer = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        // 창이 최소화되어 있거나 숨겨진 상태에서는 백그라운드 호출 일시 중지
        if (mainWindow.isMinimized() || !mainWindow.isVisible()) return;
        syncChartsNow();
    }, 15000);
}

// ====================================================================
// ★ 6. 자동 업데이트 설정
// ====================================================================
if (!app.isPackaged) {
    autoUpdater.updateConfigPath = path.join(__dirname, 'dev-app-update.yml');
}

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox({
        type: 'info',
        title: '업데이트 설치 알림',
        message: `새로운 버전(v${info.version})이 다운로드되었습니다.\n지금 프로그램을 재시작하여 적용하시겠습니까?`,
        buttons: ['지금 재시작', '나중에']
    }).then((result) => {
        if (result.response === 0) {
            autoUpdater.quitAndInstall();
        }
    });
});

// ====================================================================
// ★ 7. 일렉트론 윈도우 생성 (깜빡임 제거 + 서버 예열 + 포커스 동기화)
// ====================================================================
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 1080,
        show: false, // 초기 렌더링 완료 후 표시하여 회색 화면 깜빡임 제거
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js')
        },
        title: "BlockTeam HIS",
        backgroundColor: '#191a1c',
        icon: path.join(__dirname, 'assets', 'icon.png')
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.loadURL('file://' + __dirname + '/views/login.ejs');

    mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send('cache-loaded');
        // 사용자가 아이디/비밀번호를 입력하는 동안 GAS 서버 컨테이너 미리 예열
        requestGAS('ping').catch(() => {});
    });

    // 다른 창을 보다가 앱을 다시 클릭했을 때 즉시 차등 동기화 실행
    mainWindow.on('focus', () => {
        if (sessionToken && localCache.isLoaded) {
            syncChartsNow();
        }
    });

    mainWindow.webContents.on('before-input-event', async (event, input) => {
        if (input.key === 'F5' && input.type === 'keyDown') {
            event.preventDefault();
            if (sessionToken) {
                console.log('[Sync] F5 refresh requested: starting forced Drive sync...');
                await loadEverythingToCache();
            }
            mainWindow.reload();
        }
    });
}

// ====================================================================
// ★ 8. 앱 시작 및 종료
// ====================================================================
app.whenReady().then(() => {
    createWindow();
    autoUpdater.checkForUpdatesAndNotify();
});

app.on('window-all-closed', () => {
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ====================================================================
// ★ 9. IPC 통신 처리
// ====================================================================

// 앱 버전 조회 요청
ipcMain.on('request-app-version', (event) => {
    event.reply('receive-app-version', app.getVersion());
});

// 캐시 상태 확인
ipcMain.on('check-cache-status', (event) => {
    event.reply('cache-loaded');
});

// ====================================================================
// 로그인 (1회 왕복 통합 로딩 최적화)
// ====================================================================
ipcMain.on('request-login', async (event, creds) => {
    if (!creds || !creds.id || !creds.password) {
        return event.reply('login-failed', '아이디와 비밀번호를 입력해주세요.');
    }

    console.log(`[Auth] Login attempt | ID: ${creds.id}`);
    const result = await requestGAS('login', {
        id: creds.id,
        password: creds.password
    });

    if (result && result.success && result.token) {
        sessionToken = result.token;
        currentDoctorId = result.user.id;
        currentUserRole = result.user.role || 'doctor';

        if (result.data) {
            localCache.departments = result.data.departments || [];
            localCache.users = result.data.users || [];
            localCache.patients = result.data.patients || [];
            localCache.charts = result.data.charts || [];
            localCache.chartsVersion = result.chartsVersion || null;
            localCache.patientsVersion = result.patientsVersion || null;
            localCache.isLoaded = true;
            console.log(`[Sync] Initial fetch complete: ${localCache.departments.length} depts, ${localCache.patients.length} items, ${localCache.charts.length} charts cached`);
        } else {
            await loadEverythingToCache();
        }

        startAutoSync();

        const targetPage = currentUserRole === 'admin' ? 'admin.ejs' : 'selection.ejs';
        mainWindow.loadURL('file://' + __dirname + '/views/' + targetPage);
    } else {
        console.warn(`[Auth] Login failed: ${result ? result.message : 'No response from server'}`);
        event.reply('login-failed', result && result.message ? result.message : '계정 정보가 일치하지 않습니다.');
    }
});

// 메타데이터 요청
ipcMain.on('request-metadata', (event) => {
    event.reply('receive-metadata', {
        patients: localCache.patients,
        departments: localCache.departments,
        users: localCache.users
    });
});

// 환자 선택 (캐시 내 최신 포스트잇 포함 데이터 반영)
ipcMain.on('patient-selected', (event, patient) => {
    const latest = localCache.patients.find(p => String(p.id) === String(patient.id));
    currentPatient = latest || patient;
    mainWindow.loadURL('file://' + __dirname + '/views/index.ejs');

    mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send('init-patient-data', currentPatient);
        mainWindow.webContents.send('init-user-role', currentUserRole);
    });
});

// 데이터 리로드
ipcMain.on('request-patient-data', (event) => {
    if (currentPatient) {
        const latest = localCache.patients.find(p => String(p.id) === String(currentPatient.id));
        if (latest) currentPatient = latest;
        event.reply('init-patient-data', currentPatient);
        event.reply('init-user-role', currentUserRole);
    }
});

// 차트 기록 불러오기
ipcMain.on('request-history', (event, patientId) => {
    const pid = patientId || (currentPatient ? currentPatient.id : null);
    if (!pid) return;

    const history = localCache.charts.filter(c => c.patientId === pid);
    history.sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));

    event.reply('load-history', history);
});

// 차팅 저장
ipcMain.on('save-soap-signed', async (event, payload) => {
    if (currentUserRole === 'viewer') {
        return event.reply('save-failed', '작성 권한이 없습니다.');
    }

    const timestamp = Date.now();
    const docUser = localCache.users.find(u => u.id === currentDoctorId);

    const requestData = {
        id: timestamp,
        soapData: payload.soapData,
        signature: "Signed by " + currentDoctorId,
        doctorId: currentDoctorId,
        doctorName: docUser ? docUser.name : currentDoctorId,
        doctorMajor: docUser ? docUser.major : '',
        patientId: currentPatient.id,
        savedAt: new Date(timestamp).toISOString()
    };

    localCache.charts.push(requestData);

    event.reply('save-success', {
        msg: `✅ 저장 완료!`,
        savedItem: requestData
    });

    const dept = localCache.departments.find(d => d.id === currentPatient.deptId);
    const deptName = dept ? `${dept.name}(${dept.id})` : `미분류(${currentPatient.deptId})`;
    const safeName = currentPatient.name.replace(/[\\/:*?"<>|]/g, "");
    const fileName = `${safeName}(${currentPatient.id})_${timestamp}.json`;

    pendingChartSaves++;
    requestGAS('saveChart', {
        fileName,
        deptName,
        chartData: requestData
    }).then((res) => {
        if (res && res.success && res.version) {
            localCache.chartsVersion = res.version;
        }
    }).finally(() => {
        pendingChartSaves = Math.max(0, pendingChartSaves - 1);
    });
});

// 포스트잇(상시 메모) 자동 저장
ipcMain.on('save-postit', (event, { patientId, postIt }) => {
    if (currentUserRole === 'viewer') return;

    const pid = patientId || (currentPatient ? currentPatient.id : null);
    if (!pid) return;

    const pIndex = localCache.patients.findIndex(p => String(p.id) === String(pid));
    if (pIndex > -1) {
        localCache.patients[pIndex].postIt = postIt;
    }

    if (currentPatient && String(currentPatient.id) === String(pid)) {
        currentPatient.postIt = postIt;
    }

    event.reply('postit-saved');

    pendingChartSaves++;
    requestGAS('updatePostIt', {
        patientId: pid,
        postIt: postIt
    }).then((res) => {
        if (res && res.success && res.patientsVersion) {
            localCache.patientsVersion = res.patientsVersion;
        }
    }).finally(() => {
        pendingChartSaves = Math.max(0, pendingChartSaves - 1);
    });
});

// 관리자: 부서 추가
ipcMain.on('admin-add-dept', async (e, d) => {
    localCache.departments.push(d);
    e.reply('action-result', '콘텐츠 추가 완료');
    requestGAS('addDept', { departments: localCache.departments });
});

// 관리자: 환자 추가
ipcMain.on('admin-add-patient', async (e, d) => {
    localCache.patients.push(d);
    e.reply('action-result', '항목 생성 완료');
    requestGAS('addPatient', { patientData: d });
});

// 관리자: 유저 추가
ipcMain.on('admin-add-user', async (e, d) => {
    localCache.users.push(d);
    e.reply('action-result', '계정 생성 완료');
    requestGAS('addUser', { users: localCache.users });
});

// 관리자: 전체 차트 불러오기
ipcMain.on('admin-get-charts', (e) => {
    let allCharts = [...localCache.charts];
    allCharts.sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));
    e.reply('admin-charts-data', allCharts);
});

// 관리자: 차트 삭제
ipcMain.on('admin-delete-chart', async (e, id) => {
    localCache.charts = localCache.charts.filter(c => c.id !== id);
    e.reply('action-result', '삭제 완료 (클라우드 동기화 중...)');
    pendingChartSaves++;
    requestGAS('deleteChart', { chartId: id }).then((res) => {
        if (res && res.success && res.version) {
            localCache.chartsVersion = res.version;
        }
    }).finally(() => {
        pendingChartSaves = Math.max(0, pendingChartSaves - 1);
    });
});

// 관리자: 담당 변경
ipcMain.on('admin-update-patient', async (e, data) => {
    const pIndex = localCache.patients.findIndex(p => p.id === data.id);
    if (pIndex > -1) {
        localCache.patients[pIndex].inChargeId = (data.inChargeId === 'unassigned') ? '' : data.inChargeId;
    }

    if (currentPatient && currentPatient.id === data.id) {
        currentPatient.inChargeId = localCache.patients[pIndex].inChargeId;
        if (mainWindow) {
            mainWindow.webContents.send('init-patient-data', currentPatient);
        }
    }

    e.reply('action-result', '담당 변경 완료 (클라우드 동기화 중...)');

    if (pIndex > -1) {
        requestGAS('updatePatient', { patientData: localCache.patients[pIndex] });
    }
});

// PDF 생성 로직
ipcMain.on('generate-real-pdf', async (event, { html, filename }) => {
    try {
        const { filePath } = await dialog.showSaveDialog({
            title: 'PDF 저장',
            defaultPath: filename,
            filters: [{ name: 'PDF 파일', extensions: ['pdf'] }]
        });

        if (!filePath) return;

        let printWindow = new BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });

        const tempHtmlPath = path.join(app.getPath('temp'), 'temp_pdf.html');
        fs.writeFileSync(tempHtmlPath, html, 'utf8');

        await printWindow.loadURL(`file://${tempHtmlPath}`);

        try {
            const pdfBuffer = await printWindow.webContents.printToPDF({
                printBackground: true,
                pageSize: 'A4'
            });
            fs.writeFileSync(filePath, pdfBuffer);
            printWindow.close();
        } catch (pdfErr) {
            console.error('[PDF] Conversion error:', pdfErr);
            printWindow.close();
        }

    } catch (err) {
        console.error('[PDF] Save dialog error:', err);
    }
});