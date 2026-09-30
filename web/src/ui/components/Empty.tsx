/** Empty states speak like the instrument (spec 35). */
export function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div class="empty" role="status">
      <strong>{title}</strong>
      {hint}
    </div>
  );
}
