declare module 'argon2-browser' {
  export enum ArgonType {
    Argon2d = 0,
    Argon2i = 1,
    Argon2id = 2,
  }

  export interface HashOptions {
    pass: Uint8Array | string;
    salt: Uint8Array | string;
    type?: ArgonType;
    hashLen?: number;
    mem?: number;
    time?: number;
    parallelism?: number;
  }

  export interface HashResult {
    hash: ArrayBuffer;
    hashHex: string;
    encoded: string;
  }

  export function hash(options: HashOptions): Promise<HashResult>;
}
