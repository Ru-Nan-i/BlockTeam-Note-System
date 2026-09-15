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

        console.log(`📡 GAS 응답 [${action}] | 상태: ${response.status} | 길이: ${text.length}`);

        if (!text || !text.trim()) {
            console.error(`❌ GAS가 빈 응답을 반환했습니다. [${action}]`);
            return {
                success: false,
                message: `GAS 빈 응답 (HTTP ${response.status})`
            };
        }

        try {
            const result = JSON.parse(text);

            if (!response.ok || result.success === false) {
                console.error(`❌ GAS 작업 실패 [${action}]:`, result.message);
            }

            // 세션 만료 시 로그인 화면으로 전환
            if (result && result.code === 'UNAUTHORIZED' && action !== 'login') {
                console.warn("⚠️ 세션이 만료되어 로그인 화면으로 이동합니다.");
                sessionToken = null;
                localCache.isLoaded = false;
                if (autoSyncTimer) clearInterval(autoSyncTimer);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.loadURL('file://' + __dirname + '/views/login.ejs');
                }
            }

            return result;

        } catch (jsonError) {
            console.error(`❌ GAS 응답 JSON 파싱 실패 [${action}] / 원본: ${text}`);
            return {
                success: false,
                message: `GAS가 JSON이 아닌 응답을 반환했습니다. HTTP ${response.status}`,
                rawResponse: text
            };
        }

    } catch (error) {
        console.error(`❌ GAS 통신 에러 (${action}):`, error);
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
    console.log("📥 GAS를 통해 드라이브에서 전체 데이터를 불러옵니다...");

    const result = await requestGAS('loadAll');

    if (result.success && result.data) {
        localCache.departments = result.data.departments || [];
        localCache.users = result.data.users || [];
        localCache.patients = result.data.patients || [];
        localCache.charts = result.data.charts || [];
        localCache.isLoaded = true;

        console.log("⚡ 캐싱 완료! 모든 조회가 즉시 처리됩니다.");
        console.log(`   부서: ${localCache.departments.length}개 | 유저: ${localCache.users.length}명 | 항목: ${localCache.patients.length}개 | 차트: ${localCache.charts.length}개`);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('cache-loaded');
        }

    } else {
        console.error("데이터 로드 실패:", result ? result.message : '응답 없음');
    }
}

// ====================================================================
// ★ 5. 백그라운드 자동 동기화 (10초 주기)
// ====================================================================
let autoSyncTimer = null;

function startAutoSync() {
    if (autoSyncTimer) clearInterval(autoSyncTimer);

    autoSyncTimer = setInterval(async () => {
        if (!sessionToken || !localCache.isLoaded) return;

        try {
            const result = await requestGAS('syncCharts');

            if (result.success && result.data) {
                const latestCharts = result.data;
                const chartMap = new Map();

                localCache.charts.forEach(c => {
                    if (c && c.id) chartMap.set(String(c.id), c);
                });

                latestCharts.forEach(c => {
                    if (c && c.id) chartMap.set(String(c.id), c);
                });

                const mergedCharts = Array.from(chartMap.values());

                if (mergedCharts.length !== localCache.charts.length) {
                    console.log("🔔 [실시간 감지] 새로운 차팅 데이터가 동기화되었습니다!");
                    localCache.charts = mergedCharts;

                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('auto-sync-updated');
                    }
                }
            }

        } catch (err) {
            console.log("백그라운드 동기화 대기 중...");
        }

    }, 10000);
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
// ★ 7. 일렉트론 윈도우 생성
// ====================================================================
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 1080,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js')
        },
        title: "BlockTeam HIS",
        backgroundColor: '#2f3136',
        icon: path.join(__dirname, 'assets', 'icon.png')
    });

    mainWindow.loadURL('file://' + __dirname + '/views/login.ejs');

    mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send('cache-loaded');
    });

    mainWindow.webContents.on('before-input-event', async (event, input) => {
        if (input.key === 'F5' && input.type === 'keyDown') {
            event.preventDefault();
            if (sessionToken) {
                console.log("🔄 F5 새로고침 요청: 드라이브 강제 동기화 시작!");
                await loadEverythingToCache();
            }
            mainWindow.reload();
        }
    });
}

// ====================================================================
// ★ 8. 앱 시작
// ====================================================================
app.whenReady().then(() => {
    createWindow();
    autoUpdater.checkForUpdatesAndNotify();
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

    console.log(`🔐 [초고속 통합 로그인 시도] ID: ${creds.id}`);
    const result = await requestGAS('login', {
        id: creds.id,
        password: creds.password
    });

    if (result && result.success && result.token) {
        sessionToken = result.token;
        currentDoctorId = result.user.id;
        currentUserRole = result.user.role || 'doctor';

        // 로그인 응답에 함께 온 데이터로 즉시 캐시 적재 (추가 loadAll 호출 제거)
        if (result.data) {
            localCache.departments = result.data.departments || [];
            localCache.users = result.data.users || [];
            localCache.patients = result.data.patients || [];
            localCache.charts = result.data.charts || [];
            localCache.isLoaded = true;
            console.log(`⚡ 1회 통신 완료: 부서 ${localCache.departments.length}개, 항목 ${localCache.patients.length}개, 차트 ${localCache.charts.length}개 캐싱됨`);
        } else {
            await loadEverythingToCache();
        }

        // 백그라운드 실시간 동기화 개시
        startAutoSync();

        // 화면 전환
        const targetPage = currentUserRole === 'admin' ? 'admin.ejs' : 'selection.ejs';
        mainWindow.loadURL('file://' + __dirname + '/views/' + targetPage);
    } else {
        console.warn(`❌ 로그인 실패: ${result ? result.message : '서버 무응답'}`);
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

// 환자 선택
ipcMain.on('patient-selected', (event, patient) => {
    currentPatient = patient;
    mainWindow.loadURL('file://' + __dirname + '/views/index.ejs');

    mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send('init-patient-data', currentPatient);
        mainWindow.webContents.send('init-user-role', currentUserRole);
    });
});

// 데이터 리로드
ipcMain.on('request-patient-data', (event) => {
    if (currentPatient) {
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

    requestGAS('saveChart', {
        fileName,
        deptName,
        chartData: requestData
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
    requestGAS('deleteChart', { chartId: id });
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
            console.error('PDF 변환 오류:', pdfErr);
            printWindow.close();
        }

    } catch (err) {
        console.error('PDF 저장 대화상자 오류:', err);
    }
});