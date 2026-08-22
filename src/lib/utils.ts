import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value)
}

// O SQLite grava created_at/updated_at como "YYYY-MM-DD HH:MM:SS" em UTC
// (CURRENT_TIMESTAMP), sem indicar fuso. `new Date("YYYY-MM-DD HH:MM:SS")`
// (sem "T"/"Z") é interpretado como horário LOCAL pelo motor JS — então toda
// data do banco aparecia com o horário errado (deslocado pelo fuso do
// usuário). Isso normaliza pra ISO UTC de verdade antes de criar o Date.
export function parseDbDate(dateString: string): Date {
  const iso = dateString.includes('T') ? dateString : `${dateString.replace(' ', 'T')}Z`
  return new Date(iso)
}

export function formatDate(dateString: string): string {
  return parseDbDate(dateString).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str
  return str.slice(0, length) + '...'
}
