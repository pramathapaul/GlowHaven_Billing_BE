/**
 * Money helpers: amounts are handled in integer paise (x100) for all
 * calculations, then rounded back to rupees when persisted. This avoids
 * classic floating point drift in subtotal/discount/total.
 */
export const toPaise = (amount) => Math.round(Number(amount) * 100);
export const fromPaise = (paise) => Math.round(paise) / 100;

export function calcBillTotals({ subtotalPaise, deliveryPaise = 0, discountRate = 0 }) {
  const discount = Math.round((subtotalPaise * Number(discountRate)) / 100);
  const total = Math.max(0, subtotalPaise + Number(deliveryPaise) - discount);
  return {
    subtotal: fromPaise(subtotalPaise),
    delivery_charge: fromPaise(deliveryPaise),
    discount: fromPaise(discount),
    total: fromPaise(total),
  };
}
