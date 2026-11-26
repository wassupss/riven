import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// shadcn/ui's class joiner: merges Tailwind classes so the last one wins.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
