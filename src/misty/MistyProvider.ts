import { MistyApi } from "./MistyWorker"; 

let mistyInstance: MistyApi | null = null;

export const getMistyInstance = (ip?: string) => {
  if (!mistyInstance && ip) {
    mistyInstance = new MistyApi(ip);
  }
  return mistyInstance;
};
