export interface ExtractedData {
  documentType: string;
  documentNumber: string;
  issueDate: string;
  subject: string;
  signer: string;
  recipients: string;
}

export interface ProcessedFile {
  id: string;
  file: File;
  status: 'pending' | 'processing' | 'success' | 'error';
  extractedData?: ExtractedData;
  errorMessage?: string;
  driveUploadStatus: 'idle' | 'uploading' | 'success' | 'error';
  driveFileId?: string;
  driveErrorMessage?: string;
}