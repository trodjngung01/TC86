
import { GoogleGenAI, Type } from "@google/genai";
import { fileToBase64 } from '../utils/fileUtils';
import { ExtractedData } from '../types';

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("API_KEY is not set. Please set it in your environment variables.");
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    documentType: {
      type: Type.STRING,
      description: 'Loại văn bản (ví dụ: Công văn, Hợp đồng, Quyết định).',
    },
    documentNumber: {
      type: Type.STRING,
      description: 'Số và ký hiệu của văn bản.',
    },
    issueDate: {
      type: Type.STRING,
      description: 'Ngày tháng năm ban hành văn bản.',
    },
    subject: {
      type: Type.STRING,
      description: 'Trích yếu nội dung văn bản (tóm tắt ngắn gọn).',
    },
    signer: {
      type: Type.STRING,
      description: 'Người ký văn bản (chỉ họ tên, không chức vụ).',
    },
    recipients: {
      type: Type.STRING,
      description: 'Nơi nhận (liệt kê các đơn vị chính).',
    },
  },
  required: ['documentType', 'documentNumber', 'issueDate', 'subject', 'signer', 'recipients'],
};

const prompt = `
Bạn là một trợ lý văn phòng chuyên nghiệp, có nhiệm vụ trích xuất thông tin quan trọng từ các tài liệu PDF.
Hãy phân tích tệp PDF được cung cấp và trả về một đối tượng JSON chứa các thông tin sau:
- \`documentType\`: Loại văn bản (ví dụ: Công văn, Hợp đồng, Quyết định, Giấy mời, ...).
- \`documentNumber\`: Số và ký hiệu của văn bản.
- \`issueDate\`: Ngày tháng năm ban hành văn bản.
- \`subject\`: Trích yếu nội dung văn bản (tóm tắt ngắn gọn mục đích của văn bản).
- \`signer\`: Người ký văn bản (chỉ lấy họ tên, không lấy chức vụ).
- \`recipients\`: Nơi nhận (liệt kê các đơn vị chính, nếu có).

Nếu một trường thông tin không có trong văn bản, hãy trả về một chuỗi rỗng (""). Đảm bảo kết quả trả về tuân thủ đúng định dạng JSON đã được yêu cầu.
`;

export const extractDataFromPdf = async (file: File): Promise<ExtractedData> => {
  try {
    const base64String = await fileToBase64(file);

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: file.type,
              data: base64String,
            },
          },
        ],
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    });

    const jsonText = response.text.trim();
    return JSON.parse(jsonText) as ExtractedData;
  } catch (error) {
    console.error('Error extracting data from PDF:', error);
    if (error instanceof Error) {
        throw new Error(`Lỗi khi xử lý file: ${error.message}`);
    }
    throw new Error('Đã xảy ra lỗi không xác định khi xử lý file.');
  }
};
