import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Google Drive API setup
async function getDriveClient() {
  if (!process.env.GOOGLE_DRIVE_CLIENT_EMAIL || !process.env.GOOGLE_DRIVE_PRIVATE_KEY) {
    throw new Error('Google Drive credentials not configured');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_DRIVE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_DRIVE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      project_id: process.env.GOOGLE_DRIVE_PROJECT_ID || 'marom-website'
    },
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });

  const authClient = await auth.getClient();
  return google.drive({ version: 'v3', auth: authClient });
}

// Find or create backup folder
async function getOrCreateBackupFolder(drive) {
  const folderName = 'Marom-Backups';
  
  try {
    // Search for existing folder
    const response = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)'
    });

    if (response.data.files.length > 0) {
      return response.data.files[0].id;
    }

    // Create folder if it doesn't exist
    const folder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder'
      },
      fields: 'id'
    });

    return folder.data.id;
  } catch (error) {
    console.error('[Backup] Error finding/creating folder:', error.message);
    throw error;
  }
}

// Backup a file to Google Drive
export async function backupFileToDrive(filePath, fileName) {
  try {
    if (!process.env.GOOGLE_DRIVE_CLIENT_EMAIL || !process.env.GOOGLE_DRIVE_PRIVATE_KEY) {
      console.warn('[Backup] Google Drive credentials not configured');
      return { success: false, error: 'Google Drive not configured' };
    }

    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File does not exist' };
    }

    const drive = await getDriveClient();
    const folderId = await getOrCreateBackupFolder(drive);
    
    const dateStr = new Date().toISOString().split('T')[0];
    const fileMetadata = {
      name: `${fileName}_${dateStr}.json`,
      parents: [folderId]
    };

    const media = {
      mimeType: 'application/json',
      body: fs.createReadStream(filePath)
    };

    const file = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink, createdTime'
    });

    console.log(`[Backup] ✅ Backed up ${fileName} to Google Drive: ${file.data.name}`);
    
    return {
      success: true,
      fileId: file.data.id,
      fileName: file.data.name,
      link: file.data.webViewLink,
      createdTime: file.data.createdTime
    };
  } catch (error) {
    console.error(`[Backup] ❌ Error backing up ${fileName}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Backup all critical files
export async function backupAllFiles() {
  const filesToBackup = [
    { path: path.join(__dirname, '../memory/company.json'), name: 'company-profile' },
    { path: path.join(__dirname, '../data/audiences.json'), name: 'audiences' },
    { path: path.join(__dirname, '../memory/conversations.json'), name: 'conversations' }
  ];

  const results = [];
  
  for (const file of filesToBackup) {
    if (fs.existsSync(file.path)) {
      const result = await backupFileToDrive(file.path, file.name);
      results.push({ file: file.name, ...result });
    } else {
      results.push({ file: file.name, success: false, error: 'File does not exist' });
    }
  }

  return results;
}

