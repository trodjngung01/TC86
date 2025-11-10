// @ts-nocheck

const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';

let tokenClient = null;
let pickerApiLoaded = false;
let initPromise = null; // Store the promise to avoid re-initializing

function loadScript(src) {
  return new Promise((resolve, reject) => {
    // If script already exists, just resolve
    if (document.querySelector(`script[src="${src}"]`)) {
      return resolve();
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Không thể tải script: ${src}`));
    document.body.appendChild(script);
  });
}


export const initClient = (callback) => {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const GOOGLE_CLIENT_ID = document.querySelector('meta[name="google-signin-client_id"]')?.getAttribute('content') || '';

        if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.startsWith('YOUR_')) {
          return { loaded: false, error: 'Google Client ID chưa được cấu hình. Vui lòng cập nhật tệp index.html.' };
        }
        
        // Load the Google API scripts dynamically and sequentially
        await loadScript('https://apis.google.com/js/api.js');
        await loadScript('https://accounts.google.com/gsi/client');

        // Initialize GAPI client and picker
        await new Promise((resolve, reject) => {
          window.gapi.load('client:picker', {
            callback: () => {
              pickerApiLoaded = true;
              resolve();
            },
            onerror: () => {
              reject(new Error('Không thể tải thư viện Google API (Client hoặc Picker).'));
            },
          });
        });

        // Initialize GIS token client
        tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPES,
          callback: '', // Will be overwritten in signIn
        });

        return { loaded: true };
      } catch (error) {
        console.error("Google API initialization failed:", error);
        const message = error instanceof Error ? error.message : 'Khởi tạo Google Sign-In thất bại. Vui lòng kiểm tra lại Google Client ID và cấu hình dự án.';
        return { loaded: false, error: message };
      }
    })();
  }
  initPromise.then(callback);
};


export const signIn = (): Promise<{ success: boolean; profile?: any }> => {
  return new Promise((resolve) => {
    if (!tokenClient) {
      console.error("Google Sign-In client (tokenClient) is not initialized.");
      return resolve({ success: false });
    }

    tokenClient.callback = async (resp) => {
      if (resp.error !== undefined) {
        console.error("Google Sign-In Error:", resp);
        // Don't resolve with error if user just closed the popup
        if (resp.error !== 'popup_closed_by_user' && resp.error !== 'access_denied') {
            // Can add more specific error handling here if needed
        }
        return resolve({ success: false });
      }
      
      window.gapi.client.setToken(resp);

      try {
        await window.gapi.client.load('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest');
        await window.gapi.client.load('https://sheets.googleapis.com/$discovery/rest?version=v4');
        
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
          headers: {
            'Authorization': `Bearer ${resp.access_token}`
          }
        });

        if (!userInfoResponse.ok) {
            const errorBody = await userInfoResponse.text();
            throw new Error(`Failed to fetch user info: ${userInfoResponse.status} - ${errorBody}`);
        }

        const profile = await userInfoResponse.json();
        
        resolve({ success: true, profile: profile });
      } catch (e) {
        console.error('Error during post-signin operations:', e);
        resolve({ success: false });
      }
    };

    // For an explicit sign-in button, always prompt for consent if necessary.
    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
};


export const signOut = () => {
  const token = window.gapi.client.getToken();
  if (token !== null) {
    window.google.accounts.oauth2.revoke(token.access_token, () => {
      window.gapi.client.setToken('');
    });
  }
};

const createPicker = (view: any, callback: (data: any) => void): void => {
  const GEMINI_API_KEY = process.env.API_KEY;
  if (!pickerApiLoaded) {
      console.error("Picker API is not loaded.");
      return;
  };
  const picker = new window.google.picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(window.gapi.client.getToken().access_token)
    .setDeveloperKey(GEMINI_API_KEY)
    .setCallback(callback)
    .build();
  picker.setVisible(true);
};

export const showFolderPicker = (): Promise<{ id: string; name: string } | null> => {
  return new Promise((resolve) => {
    const view = new window.google.picker.View(window.google.picker.ViewId.FOLDERS)
      .setMimeTypes('application/vnd.google-apps.folder');
    const callback = (data) => {
      if (data[window.google.picker.Response.ACTION] == window.google.picker.Action.PICKED) {
        const doc = data[window.google.picker.Response.DOCUMENTS][0];
        resolve({ id: doc[window.google.picker.Document.ID], name: doc[window.google.picker.Document.NAME] });
      } else {
        resolve(null);
      }
    };
    createPicker(view, callback);
  });
};

export const showSheetPicker = (): Promise<{ id: string; name: string } | null> => {
  return new Promise((resolve) => {
    const view = new window.google.picker.View(window.google.picker.ViewId.SPREADSHEETS);
    const callback = (data) => {
      if (data[window.google.picker.Response.ACTION] == window.google.picker.Action.PICKED) {
        const doc = data[window.google.picker.Response.DOCUMENTS][0];
        resolve({ id: doc[window.google.picker.Document.ID], name: doc[window.google.picker.Document.NAME] });
      } else {
        resolve(null);
      }
    };
    createPicker(view, callback);
  });
};

export const uploadFileToDrive = (folderId: string, file: File): Promise<string> => {
    return new Promise(async (resolve, reject) => {
        const reader = new FileReader();
        reader.readAsArrayBuffer(file);
        reader.onload = async () => {
            const fileContent = reader.result;
            const boundary = '-------314159265358979323846';
            const delimiter = "\r\n--" + boundary + "\r\n";
            const close_delim = "\r\n--" + boundary + "--";

            const metadata = {
                'name': file.name,
                'mimeType': file.type,
                'parents': [folderId]
            };

            const multipartRequestBody =
                delimiter +
                'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                'Content-Type: ' + file.type + '\r\n' +
                'Content-Transfer-Encoding: base64\r\n' +
                '\r\n' +
                btoa(new Uint8Array(fileContent).reduce((data, byte) => data + String.fromCharCode(byte), '')) +
                close_delim;

            try {
                const response = await window.gapi.client.request({
                    'path': 'https://www.googleapis.com/upload/drive/v3/files',
                    'method': 'POST',
                    'params': {'uploadType': 'multipart'},
                    'headers': {'Content-Type': 'multipart/related; boundary="' + boundary + '"'},
                    'body': multipartRequestBody
                });
                resolve(response.result.id);
            } catch (error) {
                console.error("Drive upload error:", error);
                reject(error);
            }
        };
        reader.onerror = (error) => reject(error);
    });
};

export const appendDataToSheet = (spreadsheetId: string, data: string[][]) => {
    return window.gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheetId,
        range: 'A1',
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: data
        }
    });
};