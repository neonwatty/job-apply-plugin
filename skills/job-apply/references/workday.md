### Workday

**Characteristics:**
- Multi-page wizard with heavy JavaScript
- Non-standard UI components (custom dropdowns, date pickers)
- Requires a tenant-host account realm; use [Account Setup](../../account-setup/SKILL.md) for value-free local metadata

**Approach (visible browser first):**
1. If login, CAPTCHA, MFA, or account creation is required, pause for the user. Account Setup may configure redacted local metadata, but only the user handles the live account and macOS Keychain credential.
2. Navigate through "My Information" → "My Experience" → "Application Questions"
3. Read the visible form structure on each page
4. For dropdowns: open the field, read the visible options, then choose the supported value
5. For date fields: May need to click calendar icon, then select date
6. Use "Save and Continue" for intermediate steps, but stop before "Submit" or any equivalent final action
7. Upload the resume through the visible file control and verify the filename

**Special handling:**
- Workday dropdowns: Click field → wait → read the visible options → click the supported option
- Date pickers: Inspect the actual month/year or full-date control. Verify the resulting visible date; never assume MM/DD/YYYY. Follow the bounded control fallback in [field verification](field-verification.md).
- Required fields marked with asterisk or red border after validation

---

## Bounded recovery and progress evidence

Use [ATS recovery](ats-recovery.md) for opaque save errors, session expiry,
unsupported controls, and next-page failures. A signed-in header is insufficient
session evidence. Workday error IDs such as `I|…` are opaque correlation tokens,
not field diagnoses. Changing IDs never grants another retry.
