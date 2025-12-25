import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Google Drive API setup
export async function getDriveClient() {
  if (!process.env.GOOGLE_DRIVE_CLIENT_EMAIL || !process.env.GOOGLE_DRIVE_PRIVATE_KEY) {
    throw new Error('Google Drive credentials not configured');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_DRIVE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_DRIVE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      project_id: process.env.GOOGLE_DRIVE_PROJECT_ID || 'marom-website'
    },
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive'
    ]
  });

  const authClient = await auth.getClient();
  return google.drive({ version: 'v3', auth: authClient });
}

// Share folder/file with email
async function shareWithEmail(drive, fileId, email) {
  try {
    await drive.permissions.create({
      fileId: fileId,
      requestBody: {
        role: 'reader',
        type: 'user',
        emailAddress: email
      }
    });
    console.log(`[Backup] ✅ Shared with ${email}`);
  } catch (error) {
    console.error(`[Backup] ⚠️ Failed to share with ${email}:`, error.message);
    // Don't throw - sharing failure shouldn't break backup
  }
}

// Find or create backup folder
async function getOrCreateBackupFolder(drive) {
  const folderName = 'Marom-Backups';
  const shareEmail = process.env.BACKUP_SHARE_EMAIL || 'maromcosmetic@gmail.com';
  
  try {
    // Search for existing folder
    const response = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)'
    });

    if (response.data.files.length > 0) {
      const folderId = response.data.files[0].id;
      // Ensure it's shared (in case it wasn't before)
      await shareWithEmail(drive, folderId, shareEmail);
      return folderId;
    }

    // Create folder if it doesn't exist
    const folder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder'
      },
      fields: 'id'
    });

    const folderId = folder.data.id;
    
    // Share the folder with the email
    await shareWithEmail(drive, folderId, shareEmail);
    
    return folderId;
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
      console.warn(`[Backup] File does not exist: ${filePath}`);
      return { success: false, error: 'File does not exist' };
    }

    console.log(`[Backup] Starting backup of ${fileName} from ${filePath}`);
    const drive = await getDriveClient();
    console.log(`[Backup] Google Drive client initialized`);
    const folderId = await getOrCreateBackupFolder(drive);
    console.log(`[Backup] Backup folder ID: ${folderId}`);
    
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
    console.error(`[Backup] Error stack:`, error.stack);
    return { success: false, error: error.message, details: error.stack };
  }
}

// Backup all critical files
export async function backupAllFiles() {
  console.log('[Backup] Starting backupAllFiles...');
  const filesToBackup = [
    { path: path.join(__dirname, '../memory/company.json'), name: 'company-profile' },
    { path: path.join(__dirname, '../data/audiences.json'), name: 'audiences' },
    { path: path.join(__dirname, '../memory/conversations.json'), name: 'conversations' }
  ];

  console.log('[Backup] Files to backup:', filesToBackup.map(f => ({ name: f.name, path: f.path, exists: fs.existsSync(f.path) })));

  const results = [];
  
  for (const file of filesToBackup) {
    try {
      if (fs.existsSync(file.path)) {
        console.log(`[Backup] Backing up ${file.name}...`);
        const result = await backupFileToDrive(file.path, file.name);
        results.push({ file: file.name, ...result });
        console.log(`[Backup] ${file.name} backup result:`, result.success ? 'SUCCESS' : 'FAILED');
      } else {
        console.warn(`[Backup] File does not exist: ${file.path}`);
        results.push({ file: file.name, success: false, error: 'File does not exist', path: file.path });
      }
    } catch (err) {
      console.error(`[Backup] Error processing ${file.name}:`, err.message);
      results.push({ file: file.name, success: false, error: err.message });
    }
  }

  console.log('[Backup] backupAllFiles completed. Results:', results);
  return results;
}

// ============================================
// GOOGLE DRIVE PRIMARY STORAGE FUNCTIONS
// ============================================

// Find or create data folder (for live data storage)
async function getOrCreateDataFolder(drive) {
  const folderName = 'Marom-Data';
  const shareEmail = process.env.BACKUP_SHARE_EMAIL || 'maromcosmetic@gmail.com';
  
  try {
    const response = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)'
    });

    if (response.data.files.length > 0) {
      const folderId = response.data.files[0].id;
      await shareWithEmail(drive, folderId, shareEmail);
      return folderId;
    }

    const folder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder'
      },
      fields: 'id'
    });

    const folderId = folder.data.id;
    await shareWithEmail(drive, folderId, shareEmail);
    
    return folderId;
  } catch (error) {
    console.error('[Drive Storage] Error finding/creating data folder:', error.message);
    throw error;
  }
}

// Find or create media folder
async function getOrCreateMediaFolder(drive) {
  const folderName = 'Marom-Media';
  const shareEmail = process.env.BACKUP_SHARE_EMAIL || 'maromcosmetic@gmail.com';
  
  try {
    const response = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)'
    });

    if (response.data.files.length > 0) {
      const folderId = response.data.files[0].id;
      await shareWithEmail(drive, folderId, shareEmail);
      return folderId;
    }

    const folder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder'
      },
      fields: 'id'
    });

    const folderId = folder.data.id;
    await shareWithEmail(drive, folderId, shareEmail);
    
    return folderId;
  } catch (error) {
    console.error('[Drive Storage] Error finding/creating media folder:', error.message);
    throw error;
  }
}

// Save JSON data to Google Drive (primary storage)
export async function saveDataToDrive(fileName, data) {
  try {
    if (!process.env.GOOGLE_DRIVE_CLIENT_EMAIL || !process.env.GOOGLE_DRIVE_PRIVATE_KEY) {
      console.warn('[Drive Storage] Google Drive credentials not configured');
      return { success: false, error: 'Google Drive not configured' };
    }

    const drive = await getDriveClient();
    const folderId = await getOrCreateDataFolder(drive);
    
    // Check if file already exists
    const existingFiles = await drive.files.list({
      q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id, name)'
    });

    const jsonData = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(jsonData, 'utf8');

    let fileId = null;
    if (existingFiles.data.files.length > 0) {
      // Update existing file
      fileId = existingFiles.data.files[0].id;
      await drive.files.update({
        fileId: fileId,
        media: {
          mimeType: 'application/json',
          body: buffer
        },
        fields: 'id, name, modifiedTime'
      });
      console.log(`[Drive Storage] ✅ Updated ${fileName} in Google Drive`);
    } else {
      // Create new file
      const file = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [folderId],
          mimeType: 'application/json'
        },
        media: {
          mimeType: 'application/json',
          body: buffer
        },
        fields: 'id, name, webViewLink'
      });
      fileId = file.data.id;
      
      // Share with email
      const shareEmail = process.env.BACKUP_SHARE_EMAIL || 'maromcosmetic@gmail.com';
      await shareWithEmail(drive, fileId, shareEmail);
      
      console.log(`[Drive Storage] ✅ Created ${fileName} in Google Drive`);
    }

    return {
      success: true,
      fileId: fileId,
      fileName: fileName
    };
  } catch (error) {
    console.error(`[Drive Storage] ❌ Error saving ${fileName}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Load JSON data from Google Drive
export async function loadDataFromDrive(fileName) {
  try {
    if (!process.env.GOOGLE_DRIVE_CLIENT_EMAIL || !process.env.GOOGLE_DRIVE_PRIVATE_KEY) {
      console.warn('[Drive Storage] Google Drive credentials not configured');
      return { success: false, error: 'Google Drive not configured' };
    }

    const drive = await getDriveClient();
    const folderId = await getOrCreateDataFolder(drive);
    
    // Find file
    const response = await drive.files.list({
      q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id, name)'
    });

    if (response.data.files.length === 0) {
      return { success: false, error: 'File not found', data: null };
    }

    const fileId = response.data.files[0].id;
    
    // Download file content
    const fileContent = await drive.files.get({
      fileId: fileId,
      alt: 'media'
    }, { responseType: 'text' });

    const data = JSON.parse(fileContent.data);
    console.log(`[Drive Storage] ✅ Loaded ${fileName} from Google Drive`);
    
    return {
      success: true,
      data: data,
      fileId: fileId
    };
  } catch (error) {
    console.error(`[Drive Storage] ❌ Error loading ${fileName}:`, error.message);
    return { success: false, error: error.message, data: null };
  }
}

// Upload media file (image/video) to Google Drive
export async function uploadMediaToDrive(buffer, fileName, mimeType, metadata = {}) {
  try {
    if (!process.env.GOOGLE_DRIVE_CLIENT_EMAIL || !process.env.GOOGLE_DRIVE_PRIVATE_KEY) {
      console.warn('[Drive Storage] Google Drive credentials not configured');
      return { success: false, error: 'Google Drive not configured' };
    }

    const drive = await getDriveClient();
    const folderId = await getOrCreateMediaFolder(drive);
    
    // Determine file extension from mimeType
    let ext = 'jpg';
    if (mimeType.includes('png')) ext = 'png';
    else if (mimeType.includes('gif')) ext = 'gif';
    else if (mimeType.includes('webp')) ext = 'webp';
    else if (mimeType.includes('mp4')) ext = 'mp4';
    else if (mimeType.includes('mov')) ext = 'mov';
    else if (mimeType.includes('jpeg')) ext = 'jpg';
    
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const fullFileName = `${fileName || 'media'}_${timestamp}_${randomStr}.${ext}`;
    
    const fileMetadata = {
      name: fullFileName,
      parents: [folderId],
      description: metadata.description || '',
      properties: {
        prompt: metadata.prompt || '',
        aspectRatio: metadata.aspectRatio || '',
        mode: metadata.mode || '',
        generatedAt: new Date().toISOString()
      }
    };

    const media = {
      mimeType: mimeType,
      body: buffer
    };

    const file = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink, webContentLink, thumbnailLink, createdTime, size'
    });

    // Share with email
    const shareEmail = process.env.BACKUP_SHARE_EMAIL || 'maromcosmetic@gmail.com';
    await shareWithEmail(drive, file.data.id, shareEmail);

    console.log(`[Drive Storage] ✅ Uploaded media to Google Drive: ${file.data.name}`);
    
    return {
      success: true,
      fileId: file.data.id,
      fileName: file.data.name,
      webViewLink: file.data.webViewLink,
      webContentLink: file.data.webContentLink, // Direct download link
      thumbnailLink: file.data.thumbnailLink,
      createdTime: file.data.createdTime,
      size: file.data.size
    };
  } catch (error) {
    console.error(`[Drive Storage] ❌ Error uploading media:`, error.message);
    return { success: false, error: error.message };
  }
}

// List all media files from Google Drive
export async function listMediaFromDrive(limit = 50) {
  try {
    if (!process.env.GOOGLE_DRIVE_CLIENT_EMAIL || !process.env.GOOGLE_DRIVE_PRIVATE_KEY) {
      return { success: false, error: 'Google Drive not configured', files: [] };
    }

    const drive = await getDriveClient();
    const folderId = await getOrCreateMediaFolder(drive);
    
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id, name, webViewLink, webContentLink, thumbnailLink, createdTime, size, mimeType, properties)',
      orderBy: 'createdTime desc',
      pageSize: limit
    });

    const files = response.data.files.map(file => ({
      id: file.id,
      name: file.name,
      url: file.webContentLink || file.webViewLink,
      thumbnail: file.thumbnailLink,
      createdTime: file.createdTime,
      size: file.size,
      mimeType: file.mimeType,
      prompt: file.properties?.prompt || '',
      aspectRatio: file.properties?.aspectRatio || '',
      mode: file.properties?.mode || ''
    }));

    return {
      success: true,
      files: files,
      total: files.length
    };
  } catch (error) {
    console.error('[Drive Storage] Error listing media:', error.message);
    return { success: false, error: error.message, files: [] };
  }
}

// Get direct download URL for a file (with proper permissions)
export async function getFileDownloadUrl(fileId) {
  try {
    if (!process.env.GOOGLE_DRIVE_CLIENT_EMAIL || !process.env.GOOGLE_DRIVE_PRIVATE_KEY) {
      return { success: false, error: 'Google Drive not configured' };
    }

    const drive = await getDriveClient();
    
    // Get file metadata
    const file = await drive.files.get({
      fileId: fileId,
      fields: 'webContentLink, webViewLink, name, mimeType'
    });

    return {
      success: true,
      downloadUrl: file.data.webContentLink || file.data.webViewLink,
      viewUrl: file.data.webViewLink,
      name: file.data.name,
      mimeType: file.data.mimeType
    };
  } catch (error) {
    console.error('[Drive Storage] Error getting file URL:', error.message);
    return { success: false, error: error.message };
  }
}

