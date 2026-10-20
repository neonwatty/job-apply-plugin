### Rippling

**Characteristics:**
- Auto-parses uploaded resume to pre-fill fields
- Upload resume first, then verify/correct auto-filled data
- Location uses a typeahead combobox

**Approach (visible browser first):**
1. Navigate to the URL in the host-managed visible browser
2. **Upload resume first** — Rippling will auto-parse and fill fields
3. Read the visible form to see what was auto-filled
4. Correct any mis-parsed fields
5. **Location combobox**: Clear existing value, type the correct location, wait for dropdown, click match
6. Fill any remaining required fields
7. Review the visible form without echoing its values, give a value-free field-name/status summary, stop before the final action, and let the user submit manually
