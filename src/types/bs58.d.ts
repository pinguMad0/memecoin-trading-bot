declare module 'bs58' {
    export function decode(input: string | Uint8Array): Uint8Array;
    export function encode(input: Uint8Array | number[]): string;
}
