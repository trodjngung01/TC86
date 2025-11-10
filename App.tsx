
import React, { useState, useCallback, useEffect } from 'react';
import { ProcessedFile } from './types';
import { extractDataFromPdf } from './services/geminiService';
import * as GoogleApi from './services/googleApiService';
import { UploadIcon, FileIcon, CheckCircleIcon, XCircleIcon, SpinnerIcon, GoogleIcon } from './components/Icons';

const App: React.FC = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [processedFiles, setProcessedFiles] = useState<ProcessedFile[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const [isGapiLoaded, setIsGapiLoaded] = useState(false);
  const [gapiError, setGapiError] = useState<string | null>(null);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [googleUser, setGoogleUser] = useState<any>(null);
  const [driveFolder, setDriveFolder] = useState<{ id: string; name: string } | null>(null);
  const [isSavingToSheets, setIsSavingToSheets] = useState<boolean>(false);
  const [sheetsMessage, setSheetsMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);


  useEffect(() => {
    GoogleApi.initClient((result) => {
      setIsGapiLoaded(result.loaded);
      if (result.error) {
        setGapiError(result.error);
      }
    });
  }, []);

  const handleSignOut = () => {
    GoogleApi.signOut();
    setIsSignedIn(false);
    setGoogleUser(null);
    setDriveFolder(null);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      // FIX: Explicitly type the 'file' parameter to resolve a potential type inference issue.
      const newFiles = Array.from(event.target.files).filter((file: File) => file.type === 'application/pdf');
      if (newFiles.length !== event.target.files.length) {
        setGlobalError("Một số tệp đã bị bỏ qua. Chỉ chấp nhận tệp PDF.");
      } else {
        setGlobalError(null);
      }
      setFiles(newFiles);
      setProcessedFiles([]);
    }
  };

  const handleSelectDriveFolder = async () => {
    let currentIsSignedIn = isSignedIn;

    // If not signed in, attempt to sign in first
    if (!currentIsSignedIn) {
        const { success, profile } = await GoogleApi.signIn();
        if (success) {
            setIsSignedIn(true);
            setGoogleUser(profile);
            currentIsSignedIn = true; // Update local status for immediate use
        } else {
            // User cancelled sign-in or it failed. Stop the process.
            console.log("Sign-in process was cancelled or failed.");
            return;
        }
    }

    // If we are signed in (either from before or just now), show the picker
    if (currentIsSignedIn) {
        const folder = await GoogleApi.showFolderPicker();
        if (folder) {
            setDriveFolder(folder);
        }
    }
  };

  const uploadToDrive = async (fileToProcess: ProcessedFile) => {
    if (!driveFolder) return;
    
    setProcessedFiles(prev => prev.map(pf => pf.id === fileToProcess.id ? { ...pf, driveUploadStatus: 'uploading' } : pf));
    try {
      const fileId = await GoogleApi.uploadFileToDrive(driveFolder.id, fileToProcess.file);
      setProcessedFiles(prev => prev.map(pf => pf.id === fileToProcess.id ? { ...pf, driveUploadStatus: 'success', driveFileId: fileId } : pf));
    } catch (error) {
      console.error(error);
      const errorMessage = error instanceof Error ? error.message : 'Lỗi không xác định khi tải lên Drive.';
      setProcessedFiles(prev => prev.map(pf => pf.id === fileToProcess.id ? { ...pf, driveUploadStatus: 'error', driveErrorMessage: errorMessage } : pf));
    }
  };

  const handleProcessFiles = useCallback(async () => {
    if (files.length === 0) {
      setGlobalError("Vui lòng chọn ít nhất một tệp PDF để xử lý.");
      return;
    }
    if (!driveFolder) {
      setGlobalError("Vui lòng chọn một thư mục Google Drive để lưu trữ tệp.");
      return;
    }
    
    setIsLoading(true);
    setGlobalError(null);
    setSheetsMessage(null);

    const initialProcessedFiles: ProcessedFile[] = files.map(file => ({
      id: `${file.name}-${file.lastModified}`,
      file,
      status: 'pending',
      driveUploadStatus: 'idle',
    }));
    setProcessedFiles(initialProcessedFiles);

    for (const currentFile of initialProcessedFiles) {
      setProcessedFiles(prev => prev.map(pf => pf.id === currentFile.id ? { ...pf, status: 'processing' } : pf));
      
      try {
        const data = await extractDataFromPdf(currentFile.file);
        setProcessedFiles(prev => prev.map(pf => pf.id === currentFile.id ? { ...pf, status: 'success', extractedData: data } : pf));
        // Start uploading to drive after successful extraction
        // FIX: Explicitly type `updatedFile` to ensure its `status` property is not widened to `string`.
        const updatedFile: ProcessedFile = { ...currentFile, status: 'success', extractedData: data };
        await uploadToDrive(updatedFile);

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Lỗi không xác định';
        setProcessedFiles(prev => prev.map(pf => pf.id === currentFile.id ? { ...pf, status: 'error', errorMessage } : pf));
      }
    }
    setIsLoading(false);
  }, [files, driveFolder]);

  const handleSaveToSheets = async () => {
    const successfulFiles = processedFiles.filter(pf => pf.status === 'success' && pf.extractedData);
    if (successfulFiles.length === 0) {
        setSheetsMessage({ type: 'error', text: 'Không có dữ liệu hợp lệ để lưu.' });
        return;
    }

    setIsSavingToSheets(true);
    setSheetsMessage(null);

    const sheet = await GoogleApi.showSheetPicker();
    if (sheet) {
        try {
            const header = [['Loại VB', 'Số/Ký hiệu', 'Ngày BH', 'Trích yếu', 'Người ký', 'Nơi nhận', 'Tên tệp gốc']];
            const rows = successfulFiles.map(pf => [
                pf.extractedData!.documentType,
                pf.extractedData!.documentNumber,
                pf.extractedData!.issueDate,
                pf.extractedData!.subject,
                pf.extractedData!.signer,
                pf.extractedData!.recipients,
                pf.file.name,
            ]);
            await GoogleApi.appendDataToSheet(sheet.id, header.concat(rows));
            setSheetsMessage({ type: 'success', text: `Đã lưu thành công ${rows.length} mục vào "${sheet.name}".` });
        } catch (error) {
            console.error(error);
            setSheetsMessage({ type: 'error', text: 'Lưu vào Google Sheets thất bại. Vui lòng thử lại.' });
        }
    }
    setIsSavingToSheets(false);
  };
  
  return (
    <div className="bg-slate-50 min-h-screen text-slate-800 font-sans">
      <div className="container mx-auto p-4 sm:p-6 lg:p-8">
        <Header user={googleUser} onSignOut={handleSignOut} isGapiLoaded={isGapiLoaded} isSignedIn={isSignedIn} gapiError={gapiError} />
        <main className="mt-8 space-y-8">
          <UploadSection 
            files={files} 
            driveFolder={driveFolder}
            isLoading={isLoading}
            onFileChange={handleFileChange}
            onSelectDriveFolder={handleSelectDriveFolder}
            onProcess={handleProcessFiles}
            isSignedIn={isSignedIn}
          />
          {globalError && <div className="text-red-600 bg-red-100 p-3 rounded-md text-center">{globalError}</div>}
          
          {(processedFiles.length > 0 || isLoading) && (
            <ResultsSection 
              processedFiles={processedFiles}
              onSaveToSheets={handleSaveToSheets}
              isSavingToSheets={isSavingToSheets}
              sheetsMessage={sheetsMessage}
              hasSuccessfulFiles={processedFiles.some(pf => pf.status === 'success')}
            />
          )}
        </main>
      </div>
    </div>
  );
};

interface HeaderProps {
    user: any;
    onSignOut: () => void;
    isGapiLoaded: boolean;
    isSignedIn: boolean;
    gapiError: string | null;
}

const Header: React.FC<HeaderProps> = ({ user, onSignOut, isGapiLoaded, isSignedIn, gapiError }) => (
  <header>
    <div className="flex justify-between items-center mb-4">
        <div className="w-1/3"></div>
        <div className="w-1/3 text-center">
            <h1 className="text-3xl sm:text-4xl font-bold text-slate-900">
                Trình trích xuất AI
            </h1>
        </div>
        <div className="w-1/3 flex justify-end items-center gap-3">
        {gapiError ? (
            <div className="text-sm font-medium text-red-600 bg-red-100 p-2 rounded-md shadow-sm border border-red-200">
                {gapiError}
            </div>
        ) : isGapiLoaded ? (
          isSignedIn && user ? (
            <>
              <div className="text-right text-sm">
                <p className="font-medium text-slate-800">{user.name}</p>
                <p className="text-slate-500">{user.email}</p>
              </div>
              <img src={user.picture} alt="User avatar" className="w-10 h-10 rounded-full" />
              <button onClick={onSignOut} className="text-sm font-medium text-indigo-600 hover:text-indigo-800">Đăng xuất</button>
            </>
          ) : (
            null
          )
        ) : <SpinnerIcon className="animate-spin h-5 w-5 text-slate-500" />}
        </div>
    </div>
    <p className="text-center mt-2 text-lg text-slate-600 max-w-3xl mx-auto">
      Tải lên PDF, chọn thư mục Google Drive, hệ thống sẽ tự động trích xuất thông tin và lưu vào Google Sheet bạn chọn.
    </p>
  </header>
);

interface UploadSectionProps {
  files: File[];
  driveFolder: {id: string; name: string} | null;
  isLoading: boolean;
  isSignedIn: boolean;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSelectDriveFolder: () => void;
  onProcess: () => void;
}

const UploadSection: React.FC<UploadSectionProps> = ({ files, driveFolder, isLoading, isSignedIn, onFileChange, onSelectDriveFolder, onProcess }) => (
  <div className="bg-white p-6 rounded-2xl shadow-lg border border-slate-200 space-y-6">
    <div className={`grid grid-cols-1 md:grid-cols-2 gap-6 items-end`}>
        <div>
            <label htmlFor="file-upload" className="block text-sm font-medium text-slate-700 mb-2">1. Chọn tệp PDF</label>
            <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-slate-300 border-dashed rounded-md">
                <div className="space-y-1 text-center">
                    <UploadIcon className="mx-auto h-12 w-12 text-slate-400" />
                    <div className="flex text-sm text-slate-600">
                        <label htmlFor="file-upload" className={`relative cursor-pointer bg-white rounded-md font-medium text-indigo-600 hover:text-indigo-500`}>
                            <span>Tải lên tệp</span>
                            <input id="file-upload" name="file-upload" type="file" className="sr-only" multiple accept=".pdf" onChange={onFileChange} disabled={isLoading} />
                        </label>
                        <p className="pl-1">hoặc kéo và thả</p>
                    </div>
                    <p className="text-xs text-slate-500">Chỉ chấp nhận tệp PDF</p>
                </div>
            </div>
            {files.length > 0 && (
                <div className="mt-4 text-sm text-slate-600">
                    <p className="font-semibold">Tệp đã chọn:</p>
                    <ul className="list-disc list-inside max-h-24 overflow-y-auto">
                        {files.map(f => <li key={f.name} className="truncate">{f.name}</li>)}
                    </ul>
                </div>
            )}
        </div>
        <div>
            <label htmlFor="folder" className="block text-sm font-medium text-slate-700 mb-2">2. Chọn thư mục Google Drive</label>
            <button
                onClick={onSelectDriveFolder}
                disabled={isLoading}
                className="w-full flex justify-center items-center gap-3 py-2 px-4 border border-slate-300 rounded-md shadow-sm text-sm font-medium text-slate-700 bg-white hover:bg-slate-50 disabled:bg-slate-100 disabled:cursor-not-allowed transition-colors"
            >
                <GoogleIcon className="w-5 h-5" />
                {driveFolder ? `Đã chọn: ${driveFolder.name}` : (isSignedIn ? 'Chọn thư mục...' : 'Đăng nhập & Chọn thư mục')}
            </button>
        </div>
    </div>
    <div className="pt-2 flex justify-center">
      <button
        onClick={onProcess}
        disabled={isLoading || files.length === 0 || !driveFolder || !isSignedIn}
        className="w-full md:w-1/2 flex justify-center items-center gap-3 py-3 px-4 border border-transparent rounded-full shadow-sm text-base font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:bg-slate-400 disabled:cursor-not-allowed transition-colors"
      >
        {isLoading ? (<><SpinnerIcon className="animate-spin h-5 w-5 text-white" />Đang xử lý...</>) : ("3. Bắt đầu trích xuất & Tải lên")}
      </button>
    </div>
  </div>
);

interface ResultsSectionProps {
  processedFiles: ProcessedFile[];
  onSaveToSheets: () => void;
  isSavingToSheets: boolean;
  sheetsMessage: { type: 'success' | 'error', text: string } | null;
  hasSuccessfulFiles: boolean;
}

const ResultsSection: React.FC<ResultsSectionProps> = ({ processedFiles, onSaveToSheets, isSavingToSheets, sheetsMessage, hasSuccessfulFiles }) => (
  <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-lg border border-slate-200">
    <div className="flex justify-between items-center mb-4">
        <h3 className="text-xl font-semibold text-slate-800">Kết quả trích xuất</h3>
        <button
            onClick={onSaveToSheets}
            disabled={isSavingToSheets || !hasSuccessfulFiles}
            className="flex items-center gap-2 py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:bg-slate-400 disabled:cursor-not-allowed"
        >
            {isSavingToSheets ? <SpinnerIcon className="animate-spin h-5 w-5" /> : <CheckCircleIcon className="h-5 w-5" />}
            Lưu vào Google Sheets
        </button>
    </div>
     {sheetsMessage && (
        <div className={`p-3 rounded-md mb-4 text-sm ${sheetsMessage.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
            {sheetsMessage.text}
        </div>
    )}
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-100">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Tên tệp</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Trạng thái AI</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Google Drive</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Loại VB</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Số/Ký hiệu</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Ngày BH</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Trích yếu</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Người ký</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Nơi nhận</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-slate-200">
          {processedFiles.map(pf => <ResultRow key={pf.id} fileData={pf} />)}
        </tbody>
      </table>
    </div>
    <div className="mt-4 text-sm text-slate-500">
        <p>* Bạn vẫn có thể chọn và sao chép (Ctrl+C) bảng dữ liệu trên để dán (Ctrl+V) vào Excel.</p>
    </div>
  </div>
);

const ResultRow: React.FC<{ fileData: ProcessedFile }> = ({ fileData }) => {
    const { file, status, extractedData, errorMessage, driveUploadStatus, driveErrorMessage } = fileData;
    
    const renderStatus = (s: ProcessedFile['status'], msg?: string) => {
        switch (s) {
            case 'pending': return <span className="text-slate-500">Đang chờ</span>;
            case 'processing': return <span className="flex items-center gap-2 text-blue-600"><SpinnerIcon className="animate-spin h-4 w-4" /> Đang xử lý</span>;
            case 'success': return <span className="flex items-center gap-2 text-green-600"><CheckCircleIcon className="h-5 w-5" /> Hoàn thành</span>;
            case 'error': return <span className="flex items-center gap-2 text-red-600" title={msg}><XCircleIcon className="h-5 w-5" /> Lỗi</span>;
        }
    }
    const renderDriveStatus = (s: ProcessedFile['driveUploadStatus'], msg?: string) => {
        switch (s) {
            case 'idle': return <span className="text-slate-400">-</span>;
            case 'uploading': return <span className="flex items-center gap-2 text-blue-600"><SpinnerIcon className="animate-spin h-4 w-4" /> Đang tải</span>;
            case 'success': return <span className="flex items-center gap-2 text-green-600"><CheckCircleIcon className="h-5 w-5" /> Đã tải lên</span>;
            case 'error': return <span className="flex items-center gap-2 text-red-600" title={msg}><XCircleIcon className="h-5 w-5" /> Lỗi</span>;
        }
    }

    return (
        <tr className="hover:bg-slate-50 transition-colors">
            <td className="px-4 py-3 whitespace-nowrap"><div className="flex items-center"><FileIcon className="h-5 w-5 text-slate-400 mr-2 flex-shrink-0" /><span className="text-sm font-medium text-slate-900 truncate" title={file.name}>{file.name}</span></div></td>
            <td className="px-4 py-3 whitespace-nowrap text-sm">{renderStatus(status, errorMessage)}</td>
            <td className="px-4 py-3 whitespace-nowrap text-sm">{renderDriveStatus(driveUploadStatus, driveErrorMessage)}</td>
            {status === 'success' && extractedData ? (
                <>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-600">{extractedData.documentType}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-600">{extractedData.documentNumber}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-600">{extractedData.issueDate}</td>
                    <td className="px-4 py-3 text-sm text-slate-600 max-w-xs truncate" title={extractedData.subject}>{extractedData.subject}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-600">{extractedData.signer}</td>
                    <td className="px-4 py-3 text-sm text-slate-600 max-w-xs truncate" title={extractedData.recipients}>{extractedData.recipients}</td>
                </>
            ) : (<td colSpan={6} className="px-4 py-3 text-sm text-slate-400 text-center">{status === 'error' ? (<span className="text-red-500" title={errorMessage}>Không thể trích xuất dữ liệu.</span>) : ('...')}</td>)}
        </tr>
    );
};

export default App;
