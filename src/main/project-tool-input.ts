/** Repair only the existing, unambiguous local-model argument encodings:
 * - update_project_task's sole string requirements field may contain the JSON
 *   array plus the rest of the argument object; decode that exact wrapper.
 * - edit_project_file with string path/content and omitted or exact empty
 *   revision treats omitted/exact empty expectedHash or literal string "null"
 *   as explicit create-only null, stripping the empty revision. Real conflicting
 *   preconditions and whitespace values retain their strict validation errors.
 * - edit/patch accept a UUID in expectedHash as a misplaced revision token,
 *   or a lowercase 64-character SHA in revision as a misplaced expectedHash.
 * Repairs never override another supplied precondition, fabricate missing task
 * fields, or turn patches into creates. Malformed/ambiguous input is returned
 * unchanged so callers retain their existing validation errors.
 *
 * Both SDK ingress (project-agent-runtime) and direct ProjectTools execution
 * use this helper before strict schema validation. ProjectTools still owns
 * revision lookup scoped to the chat/file, authorization and serialized writes;
 * Workspace still enforces create-only and stale-hash checks at the write.
 * Task validation/merge owns requirements:[] retention; it is not an encoding
 * repair. This helper grants no permissions and performs no file effects. */
export function normalizeProjectToolInput(name: string, raw: unknown): unknown {
  if (name === 'update_project_task' && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const fields = raw as Record<string,unknown>;
    // Some local models encode the remaining argument object inside the first
    // array field, omitting only its opening object/key. Decode only that exact
    // wrapper shape; ordinary strict schema validation still runs afterward.
    if (Object.keys(fields).length === 1 && typeof fields.requirements === 'string' && fields.requirements.trimStart().startsWith('[')) {
      try { return JSON.parse('{"requirements":' + fields.requirements); } catch { /* Return unchanged for a useful schema error. */ }
    }
  }
  if (!['patch_project_file', 'edit_project_file'].includes(name) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  // Quoted JSON null and exact empty optional preconditions mean create-only.
  // The filesystem still rejects an existing target; patches and conflicts
  // retain strict validation rather than losing a real supplied precondition.
  if (name === 'edit_project_file' && typeof value.path === 'string' && typeof value.content === 'string' &&
      (value.expectedHash === 'null' || value.expectedHash === '' || value.expectedHash === undefined) &&
      (value.revision === undefined || value.revision === '')) {
    const { revision: _revision, ...rest } = value;
    return { ...rest, expectedHash: null };
  }
  if (value.revision === undefined && typeof value.expectedHash === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.expectedHash)) {
    // Preserve the token exactly; only ProjectTools can resolve its ownership.
    const { expectedHash, ...rest } = value;
    return { ...rest, revision: expectedHash };
  }
  if (value.expectedHash === undefined && typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision)) {
    // A complete lowercase SHA is a hash, not an opaque scoped read revision.
    const { revision, ...rest } = value;
    return { ...rest, expectedHash: revision };
  }
  return raw;
}
