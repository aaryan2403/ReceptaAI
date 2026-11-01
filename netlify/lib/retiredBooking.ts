// Keep stale dashboard tabs and previously published agent tools from booking.
// Appointment request capture remains at retell-appointment.
export const retiredBookingResponse = async () => Response.json({
  success: false,
  enabled: false,
  status: 'unavailable',
  error: 'Calendar booking has been removed. Appointment requests are available in Calls.',
  instruction: 'Use recepta_save_appointment_details to record an appointment request. The business will confirm availability. Do not claim a time was reserved or email/SMS was sent.',
}, { status: 410, headers: { 'Cache-Control': 'no-store' } })
