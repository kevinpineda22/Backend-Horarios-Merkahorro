import { NOVEDADES_BUCKET } from "./domain/novedadFiles.js";

/**
 * Supabase Storage implementation of the novedades files port (client injected). The bucket is
 * private: the backend never exposes public URLs, only short-lived signed ones.
 *   createUploadUrl(path)             -> { path, signedUrl, token }
 *   exists(path)                      -> boolean
 *   createDownloadUrl(path, seconds)  -> signed URL string
 */
export function createNovedadesStorage(client, bucket = NOVEDADES_BUCKET) {
  const files = () => client.storage.from(bucket);
  return {
    async createUploadUrl(path) {
      const { data, error } = await files().createSignedUploadUrl(path);
      if (error) throw error;
      return { path, signedUrl: data.signedUrl, token: data.token };
    },

    async exists(path) {
      const { data, error } = await files().exists(path);
      if (error) throw error;
      return data === true;
    },

    async createDownloadUrl(path, expiresIn) {
      const { data, error } = await files().createSignedUrl(path, expiresIn);
      if (error) throw error;
      return data.signedUrl;
    },
  };
}
