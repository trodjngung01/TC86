import { GoogleGenAI, Type } from "@google/genai";

$(document).ready(function() {
    // --- STATE MANAGEMENT ---
    let files = [];
    let processedFiles = {}; // Use an object for easier updates by ID
    let driveFolder = null;
    let isSignedIn = false;
    let isLoading = false;
    let isSavingToSheets = false;
    
    // --- CONSTANTS ---
    const API_KEY = process.env.API_KEY;
    const GOOGLE_CLIENT_ID = $('meta[name="google-signin-client_id"]').attr('content');
    const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';
    let tokenClient = null;
    let pickerApiLoaded = false;
    let gapiInited = false;
    
    const ai = new GoogleGenAI({ apiKey: API_KEY });

    // --- UI HELPER FUNCTIONS ---

    function updateUIState() {
        const hasFiles = files.length > 0;
        const canProcess = hasFiles && driveFolder && !isLoading;
        const hasSuccessfulFiles = Object.values(processedFiles).some(pf => pf.status === 'success');

        $('#process-btn').prop('disabled', !canProcess);
        $('#save-sheets-btn').prop('disabled', !hasSuccessfulFiles || isSavingToSheets);
        
        if (isLoading) {
            $('#process-btn-text').text('Đang xử lý...');
            $('#process-btn-spinner').removeClass('d-none');
        } else {
            $('#process-btn-text').text('3. Bắt đầu trích xuất');
            $('#process-btn-spinner').addClass('d-none');
        }

        if (isSavingToSheets) {
            $('#save-sheets-btn').find('span').removeClass('d-none');
        } else {
            $('#save-sheets-btn').find('span').addClass('d-none');
        }
    }

    function setGlobalError(message) {
        if (message) {
            $('#global-error').text(message).removeClass('d-none');
        } else {
            $('#global-error').addClass('d-none');
        }
    }

    function renderFileList() {
        if (files.length === 0) {
            $('#file-list').html('');
            return;
        }
        const fileNames = files.map(f => `<li>${f.name}</li>`).join('');
        $('#file-list').html(`<p class="mb-1 fw-bold">Tệp đã chọn:</p><ul class="list-unstyled mb-0">${fileNames}</ul>`);
    }

    function renderRow(fileData) {
        const { file, status, extractedData, errorMessage, driveUploadStatus, driveErrorMessage } = fileData;
        
        const getStatusHtml = (status, msg) => {
            switch (status) {
                case 'pending': return `<span class="text-secondary">Đang chờ</span>`;
                case 'processing': return `<div class="d-flex align-items-center text-primary"><div class="spinner-border spinner-border-sm me-2" role="status"></div><span>Đang xử lý</span></div>`;
                case 'success': return `<span class="text-success fw-bold"><i class="bi bi-check-circle-fill status-icon"></i> Hoàn thành</span>`;
                case 'error': return `<span class="text-danger fw-bold" title="${msg}"><i class="bi bi-x-circle-fill status-icon"></i> Lỗi</span>`;
                default: return '-';
            }
        };

        const getDriveStatusHtml = (status, msg) => {
             switch (status) {
                case 'idle': return `<span class="text-secondary">-</span>`;
                case 'uploading': return `<div class="d-flex align-items-center text-primary"><div class="spinner-border spinner-border-sm me-2" role="status"></div><span>Đang tải</span></div>`;
                case 'success': return `<span class="text-success"><i class="bi bi-check-circle-fill status-icon"></i> Đã tải lên</span>`;
                case 'error': return `<span class="text-danger" title="${msg}"><i class="bi bi-x-circle-fill status-icon"></i> Lỗi</span>`;
                default: return '-';
            }
        };

        let dataCells = `<td colspan="6" class="text-center text-muted">${status === 'error' ? 'Không thể trích xuất dữ liệu.' : '...'}</td>`;
        if (status === 'success' && extractedData) {
            dataCells = `
                <td>${extractedData.documentType || ''}</td>
                <td>${extractedData.documentNumber || ''}</td>
                <td>${extractedData.issueDate || ''}</td>
                <td class="text-truncate" style="max-width: 150px;" title="${extractedData.subject || ''}">${extractedData.subject || ''}</td>
                <td>${extractedData.signer || ''}</td>
                <td class="text-truncate" style="max-width: 150px;" title="${extractedData.recipients || ''}">${extractedData.recipients || ''}</td>
            `;
        }

        const rowHtml = `
            <tr id="row-${fileData.id}">
                <td class="text-truncate" style="max-width: 200px;" title="${file.name}"><i class="bi bi-file-earmark-pdf me-2"></i>${file.name}</td>
                <td>${getStatusHtml(status, errorMessage)}</td>
                <td>${getDriveStatusHtml(driveUploadStatus, driveErrorMessage)}</td>
                ${dataCells}
            </tr>
        `;
        
        const existingRow = $(`#row-${fileData.id}`);
        if (existingRow.length) {
            existingRow.replaceWith(rowHtml);
        } else {
            $('#results-table-body').append(rowHtml);
        }
    }
    
    // --- FILE HANDLING ---

    function handleFileSelection(selectedFiles) {
        const pdfFiles = Array.from(selectedFiles).filter(file => file.type === 'application/pdf');
        if (pdfFiles.length !== selectedFiles.length) {
            setGlobalError("Một số tệp đã bị bỏ qua. Chỉ chấp nhận tệp PDF.");
        } else {
            setGlobalError(null);
        }
        files = pdfFiles;
        renderFileList();
        updateUIState();
    }
    
    $('#file-upload').on('change', (e) => handleFileSelection(e.target.files));

    const dropArea = $('#file-drop-area');
    dropArea.on('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropArea.addClass('hover');
    });
    dropArea.on('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropArea.removeClass('hover');
    });
    dropArea.on('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropArea.removeClass('hover');
        handleFileSelection(e.originalEvent.dataTransfer.files);
    });

    // --- GEMINI SERVICE ---
    
    const fileToBase64 = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = error => reject(error);
    });

    const extractDataFromPdf = async (file) => {
        const responseSchema = {
            type: Type.OBJECT,
            properties: {
                documentType: { type: Type.STRING, description: 'Loại văn bản (ví dụ: Công văn, Hợp đồng, Quyết định).' },
                documentNumber: { type: Type.STRING, description: 'Số và ký hiệu của văn bản.' },
                issueDate: { type: Type.STRING, description: 'Ngày tháng năm ban hành văn bản.' },
                subject: { type: Type.STRING, description: 'Trích yếu nội dung văn bản (tóm tắt ngắn gọn).' },
                signer: { type: Type.STRING, description: 'Người ký văn bản (chỉ họ tên, không chức vụ).' },
                recipients: { type: Type.STRING, description: 'Nơi nhận (liệt kê các đơn vị chính).' },
            },
            required: ['documentType', 'documentNumber', 'issueDate', 'subject', 'signer', 'recipients'],
        };
        const prompt = `Bạn là một trợ lý văn phòng chuyên nghiệp, có nhiệm vụ trích xuất thông tin quan trọng từ tài liệu PDF. Phân tích tệp và trả về một đối tượng JSON với các trường: documentType, documentNumber, issueDate, subject, signer, recipients. Nếu không tìm thấy thông tin, trả về chuỗi rỗng ("").`;

        try {
            const base64String = await fileToBase64(file);
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: { parts: [{ text: prompt }, { inlineData: { mimeType: file.type, data: base64String } }] },
                config: { responseMimeType: "application/json", responseSchema: responseSchema },
            });
            return JSON.parse(response.text.trim());
        } catch (error) {
            console.error('Lỗi khi trích xuất dữ liệu từ PDF:', error);
            throw new Error(error.message || 'Lỗi không xác định từ AI.');
        }
    };

    // --- GOOGLE API SERVICE ---
    
    async function initGoogleClient() {
        if (gapiInited) return;
        if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.startsWith('YOUR_')) {
             $('#gapi-error').text('Lỗi: Google Client ID chưa được cấu hình.');
             return;
        }

        try {
            await new Promise((resolve, reject) => gapi.load('client:picker', { callback: resolve, onerror: reject }));
            await gapi.client.init({});
            pickerApiLoaded = true;

            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: GOOGLE_CLIENT_ID,
                scope: SCOPES,
                callback: '',
            });
            gapiInited = true;
        } catch (error) {
            console.error("Google API initialization failed:", error);
            $('#gapi-error').text('Không thể khởi tạo Google API.');
        }
    }
    
    function googleSignIn() {
        return new Promise((resolve) => {
            if (!tokenClient) return resolve(false);

            tokenClient.callback = async (resp) => {
                if (resp.error) {
                    console.error("Google Sign-In Error:", resp);
                    return resolve(false);
                }
                gapi.client.setToken(resp);
                isSignedIn = true;
                await gapi.client.load('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest');
                await gapi.client.load('https://sheets.googleapis.com/$discovery/rest?version=v4');
                resolve(true);
            };
            tokenClient.requestAccessToken({ prompt: 'consent' });
        });
    }

    function createPicker(view, callback) {
        if (!pickerApiLoaded) return;
        new google.picker.PickerBuilder()
            .addView(view)
            .setOAuthToken(gapi.client.getToken().access_token)
            .setDeveloperKey(API_KEY)
            .setCallback(callback)
            .build()
            .setVisible(true);
    }
    
    function showFolderPicker() {
        return new Promise((resolve) => {
            const view = new google.picker.View(google.picker.ViewId.FOLDERS).setMimeTypes('application/vnd.google-apps.folder');
            createPicker(view, (data) => {
                if (data[google.picker.Response.ACTION] === google.picker.Action.PICKED) {
                    const doc = data[google.picker.Response.DOCUMENTS][0];
                    resolve({ id: doc[google.picker.Document.ID], name: doc[google.picker.Document.NAME] });
                } else { resolve(null); }
            });
        });
    }

    function showSheetPicker() {
        return new Promise((resolve) => {
            const view = new google.picker.View(google.picker.ViewId.SPREADSHEETS);
             createPicker(view, (data) => {
                if (data[google.picker.Response.ACTION] === google.picker.Action.PICKED) {
                    const doc = data[google.picker.Response.DOCUMENTS][0];
                    resolve({ id: doc[google.picker.Document.ID], name: doc[google.picker.Document.NAME] });
                } else { resolve(null); }
            });
        });
    }

    function uploadFileToDrive(folderId, file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsArrayBuffer(file);
            reader.onload = () => {
                 const boundary = '-------314159265358979323846';
                 const multipartRequestBody =
                    `--${boundary}\r\n` +
                    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
                    JSON.stringify({ name: file.name, mimeType: file.type, parents: [folderId] }) +
                    `\r\n--${boundary}\r\n` +
                    `Content-Type: ${file.type}\r\n\r\n` +
                    reader.result +
                    `\r\n--${boundary}--`;
                 
                 gapi.client.request({
                    path: 'https://www.googleapis.com/upload/drive/v3/files',
                    method: 'POST',
                    params: { uploadType: 'multipart' },
                    headers: { 'Content-Type': `multipart/related; boundary="${boundary}"` },
                    body: multipartRequestBody
                 }).then(response => resolve(response.result.id), error => reject(error));
            };
            reader.onerror = (error) => reject(error);
        });
    }

    async function appendDataToSheet(spreadsheetId, data) {
       return gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'A1',
            valueInputOption: 'USER_ENTERED',
            resource: { values: data }
       });
    }


    // --- MAIN LOGIC & EVENT HANDLERS ---
    
    $('#select-folder-btn').on('click', async function() {
        await initGoogleClient();
        if (!isSignedIn) {
            const success = await googleSignIn();
            if (!success) return;
        }
        
        const folder = await showFolderPicker();
        if (folder) {
            driveFolder = folder;
            $('#folder-btn-text').text(`Đã chọn: ${folder.name}`);
        }
        updateUIState();
    });

    $('#process-btn').on('click', async function() {
        if (files.length === 0) {
            setGlobalError("Vui lòng chọn tệp PDF.");
            return;
        }
        if (!driveFolder) {
            setGlobalError("Vui lòng chọn thư mục Google Drive.");
            return;
        }
        
        isLoading = true;
        setGlobalError(null);
        $('#results-card').removeClass('d-none');
        $('#results-table-body').html('');
        updateUIState();

        processedFiles = {};
        for (const file of files) {
            const fileId = `${file.name}-${file.lastModified}`;
            processedFiles[fileId] = { id: fileId, file, status: 'pending', driveUploadStatus: 'idle' };
            renderRow(processedFiles[fileId]);
        }

        for (const file of files) {
            const fileId = `${file.name}-${file.lastModified}`;
            
            // Process AI
            processedFiles[fileId].status = 'processing';
            renderRow(processedFiles[fileId]);
            try {
                const data = await extractDataFromPdf(file);
                processedFiles[fileId].status = 'success';
                processedFiles[fileId].extractedData = data;
                renderRow(processedFiles[fileId]);
                
                // Upload to Drive
                processedFiles[fileId].driveUploadStatus = 'uploading';
                renderRow(processedFiles[fileId]);
                try {
                    const driveFileId = await uploadFileToDrive(driveFolder.id, file);
                    processedFiles[fileId].driveUploadStatus = 'success';
                    processedFiles[fileId].driveFileId = driveFileId;
                } catch (driveError) {
                    console.error("Lỗi tải lên Drive:", driveError);
                    processedFiles[fileId].driveUploadStatus = 'error';
                    processedFiles[fileId].driveErrorMessage = driveError.result?.error?.message || 'Lỗi không xác định.';
                }
            } catch (aiError) {
                processedFiles[fileId].status = 'error';
                processedFiles[fileId].errorMessage = aiError.message;
            }
            renderRow(processedFiles[fileId]);
        }
        
        isLoading = false;
        updateUIState();
    });

    $('#save-sheets-btn').on('click', async function() {
        const successfulFiles = Object.values(processedFiles).filter(pf => pf.status === 'success' && pf.extractedData);
        if (successfulFiles.length === 0) {
            $('#sheets-message').text('Không có dữ liệu hợp lệ để lưu.').removeClass('d-none alert-success').addClass('alert-danger');
            return;
        }
        
        isSavingToSheets = true;
        $('#sheets-message').addClass('d-none');
        updateUIState();
        
        const sheet = await showSheetPicker();
        if (sheet) {
            try {
                const header = [['Loại VB', 'Số/Ký hiệu', 'Ngày BH', 'Trích yếu', 'Người ký', 'Nơi nhận', 'Tên tệp gốc']];
                const rows = successfulFiles.map(pf => [
                    pf.extractedData.documentType, pf.extractedData.documentNumber, pf.extractedData.issueDate,
                    pf.extractedData.subject, pf.extractedData.signer, pf.extractedData.recipients, pf.file.name
                ]);
                await appendDataToSheet(sheet.id, header.concat(rows));
                $('#sheets-message').html(`Đã lưu thành công ${rows.length} mục vào tệp "<strong>${sheet.name}</strong>".`).removeClass('d-none alert-danger').addClass('alert-success');
            } catch (error) {
                console.error("Lỗi lưu vào Sheets:", error);
                 $('#sheets-message').text('Lưu vào Google Sheets thất bại. Vui lòng thử lại.').removeClass('d-none alert-success').addClass('alert-danger');
            }
        }

        isSavingToSheets = false;
        updateUIState();
    });
    
    // Initial call to set button states
    updateUIState();
});
