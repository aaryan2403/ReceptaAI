// Interpret form values in the business timezone, independent of the staff member's phone.
export const localBookingTime = (value: string, timeZone: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose a date and time.')
  const target = Date.parse(`${value}:00Z`)
  const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  let guess = target
  for (let i = 0; i < 4; i++) {
    const actual = formatter.format(new Date(guess)).replace(' ', 'T')
    if (actual === value) {
      if ([-3600000,3600000].some(offset=>formatter.format(new Date(guess+offset)).replace(' ','T')===value)) throw new Error('That time occurs twice when the clocks change. Choose an unambiguous time.')
      return new Date(guess).toISOString()
    }
    guess += target - Date.parse(`${actual}:00Z`)
  }
  throw new Error('That time does not exist in the business timezone. Choose another time.')
}

export const bookingFormTime = (value: string, timeZone: string) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)).replace(' ', 'T')
