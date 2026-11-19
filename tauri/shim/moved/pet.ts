// src/main/pet.ts in the Tauri build: the pet's window and its 17 channels
// run in Rust (src-tauri/src/services/pet.rs), which also closes the pet when
// riven's window goes.
export function registerPetHandlers(): void {}
export function closePetWindow(): void {}
export function isPetWindowOpen(): boolean {
  return false
}
