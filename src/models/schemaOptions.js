/**
 * Shared schema options: expose `id` (string) alongside `_id` in JSON output.
 * @param {object|false} timestamps mongoose timestamps option
 */
export function jsonOptions(timestamps = false) {
  return {
    timestamps,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  };
}
