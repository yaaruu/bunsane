import { MetadataStorage } from "./metadata-storage";

declare global {
  // eslint-disable-next-line vars-on-top, no-var
  var BunsaneMetadataStorage: MetadataStorage;
}

export function getMetadataStorage(): MetadataStorage {
  if (!global.BunsaneMetadataStorage) {
    global.BunsaneMetadataStorage = new MetadataStorage();
  }

  return global.BunsaneMetadataStorage;
}