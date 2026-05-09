import fetch from 'node-fetch';

export interface YandexDiskConfig {
  token: string;
  remoteRoot: string; // e.g., 'Notes', 'Obsidian/Assistant', or 'app:/'
}

export interface RemoteFileInfo {
  name: string;
  modified: string;  // ISO date
  md5: string;
  size: number;
  path: string;
}

export class YandexDiskService {
  private token: string;
  private remoteRoot: string;
  private baseUrl = 'https://cloud-api.yandex.net/v1/disk/resources';

  constructor(config: YandexDiskConfig) {
    this.token = config.token;
    
    // Нормализация префикса (исправляем app:// на app:/ и т.д.)
    let root = config.remoteRoot || "app:/";
    
    // Если пользователь ввел app:// или disk:// — исправляем на правильный формат
    root = root.replace(/^app:\/*/, 'app:/');
    root = root.replace(/^disk:\/*/, 'disk:/');

    // Если префикса нет совсем, по умолчанию считаем от корня диска
    if (!root.startsWith('app:/') && !root.startsWith('disk:/')) {
      root = root.startsWith('/') ? root : `/${root}`;
    }
    
    this.remoteRoot = root;
  }

  private get headers() {
    return {
      'Authorization': `OAuth ${this.token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async checkConnection(): Promise<{ connected: boolean; user?: string; error?: string }> {
    try {
      // Сначала пробуем доступ к корневой папке — работает и для app-folder токенов
      const rootPath = this.remoteRoot.startsWith('app:/') ? 'app:/' : this.remoteRoot;
      const resourceResponse = await fetch(
        `${this.baseUrl}?path=${encodeURIComponent(rootPath)}`,
        { headers: this.headers }
      );

      if (resourceResponse.ok) {
        const data = await resourceResponse.json() as any;
        return { connected: true, user: data.name || rootPath };
      }

      // Если 403 на resources — токен невалиден или прав нет совсем
      if (resourceResponse.status === 401 || resourceResponse.status === 403) {
        const errData = await resourceResponse.json() as any;
        return { connected: false, error: errData.message || errData.description || `HTTP ${resourceResponse.status}` };
      }

      // Для 404 — папка не существует, но токен рабочий
      if (resourceResponse.status === 404) {
        return { connected: true, user: '(папка будет создана автоматически)' };
      }

      return { connected: false, error: `HTTP ${resourceResponse.status}` };
    } catch (error) {
      console.error('Error checking Yandex Disk connection:', error);
      return { connected: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  private getFullPath(relativePath: string): string {
    const base = this.remoteRoot.endsWith('/') ? this.remoteRoot : `${this.remoteRoot}/`;
    const full = `${base}${relativePath}`.replace(/([^:])\/+/g, '$1/');
    
    // Если это обычный путь без префикса, добавляем disk:
    if (!full.startsWith('app:/') && !full.startsWith('disk:/')) {
        return `disk:${full.startsWith('/') ? '' : '/'}${full}`;
    }
    return full;
  }

  async ensureDirExists(path: string): Promise<void> {
    if (path === 'app:/' || path === 'app:' || path === 'disk:/' || path === 'disk:') return;

    let basePrefix = '';
    let pathToSplit = path;

    if (path.startsWith('app:/')) {
        basePrefix = 'app:/';
        pathToSplit = path.substring(5);
    } else if (path.startsWith('disk:/')) {
        basePrefix = 'disk:/';
        pathToSplit = path.substring(6);
    } else if (path.startsWith('/')) {
        basePrefix = '/';
        pathToSplit = path.substring(1);
    }

    const parts = pathToSplit.split('/').filter(Boolean);
    let currentPath = basePrefix.endsWith('/') ? basePrefix.slice(0, -1) : basePrefix;

    for (const part of parts) {
      currentPath += (currentPath.endsWith(':') ? '/' : '/') + part;
      
      try {
        const response = await fetch(`${this.baseUrl}?path=${encodeURIComponent(currentPath)}`, {
          headers: this.headers,
        });

        if (response.status === 404) {
          const createResponse = await fetch(`${this.baseUrl}?path=${encodeURIComponent(currentPath)}`, {
            method: 'PUT',
            headers: this.headers,
          });

          if (!createResponse.ok && createResponse.status !== 409) {
            throw new Error(`Failed to create directory ${currentPath}: ${createResponse.statusText}`);
          }
        }
      } catch (error) {
        console.error(`Error ensuring directory ${currentPath}:`, error);
        throw error;
      }
    }
  }

  async uploadFile(relativePath: string, content: string): Promise<void> {
    const fullPath = this.getFullPath(relativePath);
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));

    if (dirPath && dirPath !== 'app:/' && dirPath !== 'disk:/') {
      await this.ensureDirExists(dirPath);
    }

    try {
      const uploadUrlResponse = await fetch(`${this.baseUrl}/upload?path=${encodeURIComponent(fullPath)}&overwrite=true`, {
        headers: this.headers,
      });

      if (!uploadUrlResponse.ok) {
        const errorData = await uploadUrlResponse.json() as any;
        throw new Error(`Failed to get upload URL for ${fullPath}: ${errorData.message || uploadUrlResponse.statusText}`);
      }

      const { href } = await uploadUrlResponse.json() as { href: string };

      const uploadResponse = await fetch(href, {
        method: 'PUT',
        body: content,
      });

      if (!uploadResponse.ok) {
        throw new Error(`Failed to upload content to ${fullPath}: ${uploadResponse.statusText}`);
      }
    } catch (error) {
      console.error(`Error uploading file ${fullPath}:`, error);
      throw error;
    }
  }

  async deleteResource(relativePath: string): Promise<void> {
    const fullPath = this.getFullPath(relativePath);
    try {
      const response = await fetch(`${this.baseUrl}?path=${encodeURIComponent(fullPath)}&permanently=true`, {
        method: 'DELETE',
        headers: this.headers,
      });

      if (response.status !== 404 && !response.ok) {
        throw new Error(`Failed to delete resource ${fullPath}: ${response.statusText}`);
      }
    } catch (error) {
      console.error(`Error deleting resource ${fullPath}:`, error);
      throw error;
    }
  }

  /**
   * Список .md файлов в удалённой папке (для обратной синхронизации)
   */
  async listFiles(): Promise<RemoteFileInfo[]> {
    const rootPath = this.remoteRoot;
    const allFiles: RemoteFileInfo[] = [];
    let offset = 0;
    const limit = 100;

    try {
      while (true) {
        const url = `${this.baseUrl}?path=${encodeURIComponent(rootPath)}&fields=_embedded.items.name,_embedded.items.modified,_embedded.items.md5,_embedded.items.size,_embedded.items.path,_embedded.total&limit=${limit}&offset=${offset}`;
        const response = await fetch(url, { headers: this.headers });

        if (!response.ok) {
          if (response.status === 404) return []; // Папка не существует
          throw new Error(`Failed to list files: ${response.statusText}`);
        }

        const data = await response.json() as any;
        const items = data?._embedded?.items || [];

        for (const item of items) {
          if (typeof item.name === 'string' && item.name.endsWith('.md')) {
            allFiles.push({
              name: item.name,
              modified: item.modified,
              md5: item.md5 || '',
              size: item.size || 0,
              path: item.path || '',
            });
          }
        }

        const total = data?._embedded?.total || 0;
        offset += limit;
        if (offset >= total) break;
      }

      return allFiles;
    } catch (error) {
      console.error('Error listing files on Yandex Disk:', error);
      throw error;
    }
  }

  async downloadFile(relativePath: string): Promise<string> {
    const fullPath = this.getFullPath(relativePath);
    try {
      const downloadUrlResponse = await fetch(`${this.baseUrl}/download?path=${encodeURIComponent(fullPath)}`, {
        headers: this.headers,
      });

      if (!downloadUrlResponse.ok) {
        throw new Error(`Failed to get download URL for ${fullPath}: ${downloadUrlResponse.statusText}`);
      }

      const { href } = await downloadUrlResponse.json() as { href: string };
      const contentResponse = await fetch(href);
      
      if (!contentResponse.ok) {
        throw new Error(`Failed to download content from ${fullPath}: ${contentResponse.statusText}`);
      }

      return await contentResponse.text();
    } catch (error) {
      console.error(`Error downloading file ${fullPath}:`, error);
      throw error;
    }
  }
}
