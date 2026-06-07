const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const { Readable } = require('stream');
require('ejs-electron');

let mainWindow;
let currentDoctorId = null;
let currentPatient = null;
let currentUserRole = 'doctor';

// ====================================================================
// ★ 1. 구글 드라이브 API 세팅
// ====================================================================
const CLIENT_ID = ''; 
const CLIENT_SECRET = ''; 
const REFRESH_TOKEN = '';
const STORAGE_DB_ID = ''; 

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, "https://developers.google.com/oauthplayground");
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// ====================================================================
// ★ 메모리 캐시 저장소
// ====================================================================
let localCache = {
    departments: [],
    users: [],
    patients: [],
    charts: [],
    isLoaded: false 
};

// ====================================================================
// ★ 2. 구글 드라이브 조작용 마법 함수들
// ====================================================================
async function getFileOrFolderId(name, parentId, isFolder = false, createIfMissing = false) {
    const mimeQuery = isFolder ? "mimeType='application/vnd.google-apps.folder'" : "mimeType!='application/vnd.google-apps.folder'";
    const q = `${mimeQuery} and name='${name}' and '${parentId}' in parents and trashed=false`;
    try {
        const res = await drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
        if (res.data.files.length > 0) return res.data.files[0].id;
        if (createIfMissing && isFolder) {
            const createRes = await drive.files.create({
                resource: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
                fields: 'id'
            });
            return createRes.data.id;
        }
        return null;
    } catch (e) { return null; }
}

async function readJsonFromDrive(fileId, fallback = null) {
    if (!fileId) return fallback;
    try {
        const res = await drive.files.get({ fileId: fileId, alt: 'media' });
        if (typeof res.data === 'string') return JSON.parse(res.data);
        else if (typeof res.data === 'object') return res.data;
        return fallback;
    } catch (e) { return fallback; }
}

async function saveJsonToDrive(fileName, parentId, data) {
    const existingId = await getFileOrFolderId(fileName, parentId, false);
    const media = { mimeType: 'application/json', body: Readable.from(JSON.stringify(data, null, 2)) };
    if (existingId) {
        await drive.files.update({ fileId: existingId, media });
    } else {
        await drive.files.create({ resource: { name: fileName, parents: [parentId] }, media });
    }
}

async function getAllJsonInFolder(folderId) {
    if (!folderId) return [];
    try {
        const res = await drive.files.list({ q: `'${folderId}' in parents and trashed=false`, fields: 'files(id, name)' });
        const promises = res.data.files.filter(f => f.name.endsWith('.json')).map(f => readJsonFromDrive(f.id));
        const results = await Promise.all(promises);
        return results.filter(r => r !== null);
    } catch (e) { return []; }
}

async function loadEverythingToCache() {
    console.log("📥 드라이브에서 전체 데이터를 불러옵니다...");
    
    const deptId = await getFileOrFolderId('departments.json', STORAGE_DB_ID);
    const usersId = await getFileOrFolderId('users.json', STORAGE_DB_ID);
    const patientsFolderId = await getFileOrFolderId('항목 정보', STORAGE_DB_ID, true, true);
    const chartsFolderId = await getFileOrFolderId('콘텐츠 차트', STORAGE_DB_ID, true, true);

    const [departments, users, patients, chartFolders] = await Promise.all([
        readJsonFromDrive(deptId, []),
        readJsonFromDrive(usersId, []),
        getAllJsonInFolder(patientsFolderId),
        drive.files.list({ q: `'${chartsFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, fields: 'files(id)' })
    ]);

    let allCharts = [];
    if (chartFolders.data && chartFolders.data.files) {
        for (const folder of chartFolders.data.files) {
            const chartsInDept = await getAllJsonInFolder(folder.id);
            allCharts = allCharts.concat(chartsInDept);
        }
    }

    localCache.departments = departments || [];
    localCache.users = users || [];
    localCache.patients = patients || [];
    localCache.charts = allCharts.filter(c => c !== null && c.savedAt); 
    localCache.isLoaded = true;

    console.log("⚡ 캐싱 완료! 이제부터 모든 로딩이 즉시 처리됩니다.");
    
    if (mainWindow) {
        mainWindow.webContents.send('cache-loaded');
    }
}

// ====================================================================
// ★ 3. 일렉트론(화면) 및 IPC 통신 세팅
// ====================================================================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 1080,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    title: "BlockTeam HIS",
    backgroundColor: '#2f3136',
    icon: path.join(__dirname, 'assets', 'icon.png') 
  });
  mainWindow.loadURL('file://' + __dirname + '/views/login.ejs');

  mainWindow.webContents.on('before-input-event', async (event, input) => {
      if (input.key === 'F5' && input.type === 'keyDown') {
          event.preventDefault(); // 기본 새로고침(하얀 화면) 방지

          console.log("🔄 F5 새로고침 요청: 드라이브 강제 동기화 시작!");

          // 1. 화면에 즉시 로딩 오버레이 띄우기 (Javascript 주입)
          mainWindow.webContents.executeJavaScript(`
              if (!document.getElementById('f5-sync-overlay')) {
                  const div = document.createElement('div');
                  div.id = 'f5-sync-overlay';
                  div.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(47,49,54,0.85); z-index:999999; display:flex; flex-direction:column; justify-content:center; align-items:center; color:white; font-family: sans-serif; backdrop-filter: blur(5px);';
                  div.innerHTML = '<div style="margin-bottom:20px; font-size:4em; animation: spin 1s linear infinite;">🔄</div><div style="font-size:1.5em; font-weight:bold;">드라이브 동기화 중...</div><div style="font-size:0.9em; color:#b9bbbe; margin-top:15px;">새로 추가된 데이터를 긁어오고 있습니다. 잠시만 기다려주세요!</div><style>@keyframes spin { 100% { transform: rotate(360deg); } }</style>';
                  document.body.appendChild(div);
              }

              true;
          `);
          
          // 2. 캐시 데이터 다시 긁어오기 (구글 드라이브 통신)
          await loadEverythingToCache();
          
          // 3. 완료되면 화면 새로고침 (오버레이도 자연스럽게 사라지고 최신 데이터 반영)
          console.log("✅ 동기화 완료: 화면을 새로고침합니다.");
          mainWindow.reload();
      }
  });
}

app.whenReady().then(() => {
    loadEverythingToCache(); 
    createWindow();
});

ipcMain.on('check-cache-status', (event) => {
    if (localCache.isLoaded) {
        event.reply('cache-loaded');
    }
});

// 1. 로그인 
ipcMain.on('request-login', async (event, creds) => {
    if (!localCache.isLoaded) {
        return event.reply('login-failed', '데이터 초기화 중입니다. 잠시 후 다시 시도해주세요.');
    }

    const user = localCache.users.find(u => u.id === creds.id && u.pw === creds.password);
    
    if (user || creds.id === 'admin') {
        currentDoctorId = creds.id;
        currentUserRole = user ? user.role : 'admin';
        const targetPage = currentUserRole === 'admin' ? 'admin.ejs' : 'selection.ejs';
        mainWindow.loadURL('file://' + __dirname + '/views/' + targetPage);
    } else {
        event.reply('login-failed', '계정 정보가 틀렸습니다.');
    }
});

// 2. 메타데이터 요청
ipcMain.on('request-metadata', (event) => {
    event.reply('receive-metadata', { 
        patients: localCache.patients, 
        departments: localCache.departments, 
        users: localCache.users 
    });
});

// 3. 선택
ipcMain.on('patient-selected', (event, patient) => {
    currentPatient = patient;
    mainWindow.loadURL('file://' + __dirname + '/views/index.ejs');
    mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send('init-patient-data', currentPatient);
        mainWindow.webContents.send('init-user-role', currentUserRole);
    });
});

// 4. 새로고침
ipcMain.on('request-patient-data', (event) => {
    if (currentPatient) {
        event.reply('init-patient-data', currentPatient);
        event.reply('init-user-role', currentUserRole);
    }
});

// 5. 차팅 저장 (캐시 즉시 반영 + 드라이브 백그라운드 업로드)
ipcMain.on('save-soap-signed', async (event, payload) => {
    if (currentUserRole === 'viewer') return event.reply('save-failed', '권한이 없습니다.');
    
    const timestamp = Date.now();
    const requestData = {
        id: timestamp,
        soapData: payload.soapData,
        signature: "Signed by " + currentDoctorId,
        doctorId: currentDoctorId,
        patientId: currentPatient.id,
        savedAt: new Date(timestamp).toISOString()
    };

    localCache.charts.push(requestData);
    event.reply('save-success', `✅ 저장 완료! (클라우드 동기화 중...)`);

    try {
        const dept = localCache.departments.find(d => d.id === currentPatient.deptId);
        const deptName = dept ? `${dept.name}(${dept.id})` : `미분류(${currentPatient.deptId})`;

        const chartsFolderId = await getFileOrFolderId('콘텐츠 차트', STORAGE_DB_ID, true, true);
        const targetDeptFolderId = await getFileOrFolderId(deptName, chartsFolderId, true, true);

        const safeName = currentPatient.name.replace(/[\\/:*?"<>|]/g, "");
        const fileName = `${safeName}(${currentPatient.id})_${timestamp}.json`;

        await saveJsonToDrive(fileName, targetDeptFolderId, requestData);
    } catch (error) { console.error(error); }
});

// 6. 개인 기록 불러오기
ipcMain.on('request-history', (event, patientId) => {
    const pid = patientId || (currentPatient ? currentPatient.id : null);
    if (!pid) return;
    
    const history = localCache.charts.filter(c => c.patientId === pid);
    history.sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));
    
    event.reply('load-history', history);
});

// 7. 관리자: 콘텐츠/항목/유저 추가
ipcMain.on('admin-add-dept', async (e, d) => { 
    localCache.departments.push(d); 
    e.reply('action-result','콘텐츠 추가 완료'); 
    await saveJsonToDrive('departments.json', STORAGE_DB_ID, localCache.departments);
});

ipcMain.on('admin-add-patient', async (e, d) => { 
    localCache.patients.push(d); 
    e.reply('action-result','항목 생성 완료'); 
    const patientsFolderId = await getFileOrFolderId('항목 정보', STORAGE_DB_ID, true, true);
    await saveJsonToDrive(`${d.id}.json`, patientsFolderId, d);
});

ipcMain.on('admin-add-user', async (e, d) => { 
    localCache.users.push(d); 
    e.reply('action-result','계정 생성 완료'); 
    await saveJsonToDrive('users.json', STORAGE_DB_ID, localCache.users);
});

// 8. 관리자: 전체 차트 불러오기
ipcMain.on('admin-get-charts', (e) => { 
    let allCharts = [...localCache.charts];
    allCharts.sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));
    e.reply('admin-charts-data', allCharts);
});

// 9. 관리자: 차트 삭제
ipcMain.on('admin-delete-chart', async (e, id) => { 
    localCache.charts = localCache.charts.filter(c => c.id !== id);
    e.reply('action-result', '삭제 완료 (클라우드 동기화 중...)');

    try {
        const q = `name contains '_${id}.json' and trashed=false`;
        const res = await drive.files.list({ q, fields: 'files(id)' });
        if (res.data.files.length > 0) {
            for (const file of res.data.files) {
                await drive.files.update({ fileId: file.id, resource: { trashed: true } });
            }
        }
    } catch (error) { console.error(error); }
});

// 10. 관리자: 담당 변경
ipcMain.on('admin-update-patient', async (e, data) => {
    const pIndex = localCache.patients.findIndex(p => p.id === data.id);
    if (pIndex > -1) {
        localCache.patients[pIndex].inChargeId = (data.inChargeId === 'unassigned') ? '' : data.inChargeId;
    }

    if (currentPatient && currentPatient.id === data.id) {
        currentPatient.inChargeId = localCache.patients[pIndex].inChargeId;
        if (mainWindow) mainWindow.webContents.send('init-patient-data', currentPatient);
    }
    e.reply('action-result', '담당 변경 완료 (클라우드 동기화 중...)');

    try {
        const patientsFolderId = await getFileOrFolderId('항목 정보', STORAGE_DB_ID, true, false);
        await saveJsonToDrive(`${data.id}.json`, patientsFolderId, localCache.patients[pIndex]);
    } catch (err) { console.error(err); }
});

// 11. 관리자: PDF 생성 
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
            webPreferences: { nodeIntegration: true, contextIsolation: false }
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
            event.reply('action-result', `✅ PDF가 성공적으로 저장되었습니다!`);
        } catch(e) {
            console.error(e);
            event.reply('action-result', '❌ PDF를 굽는 중 오류가 발생했습니다.');
            printWindow.close();
        }

    } catch (error) {
        event.reply('action-result', '❌ PDF 생성 창을 여는 중 오류가 발생했습니다.');
    }
});