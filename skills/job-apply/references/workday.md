### Workday

**Characteristics:**
- Multi-page wizard with heavy JavaScript
- Non-standard UI components (custom dropdowns, date pickers)
- Often requires account creation (pause so the user can decide and handle it)

**Approach (visible browser first):**
1. If login, CAPTCHA, MFA, or account creation is required, pause for the user; never handle credentials or create the account
2. Navigate through "My Information" → "My Experience" → "Application Questions"
3. Read the visible form structure on each page
4. For dropdowns: open the field, read the visible options, then choose the supported value
5. For date fields: May need to click calendar icon, then select date
6. Use "Save and Continue" for intermediate steps, but stop before "Submit" or any equivalent final action
7. Upload the resume through the visible file control and verify the filename

**Special handling:**
- Workday dropdowns: Click field → wait → read the visible options → click the supported option
- Date pickers: Often format-sensitive, try MM/DD/YYYY
- Required fields marked with asterisk or red border after validation

---
