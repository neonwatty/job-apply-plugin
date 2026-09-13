### Lever

**Characteristics:**
- Often hosted on the company's own domain (e.g., `company.com/careers/...?lever-source=LinkedIn`)
- Form typically at the bottom of a long job description page
- Text fields for name, email, phone, LinkedIn, etc.
- Radio buttons for screening questions — often use custom overlays that intercept clicks

**Approach (visible browser first):**
1. Navigate to the URL in the host-managed visible browser
2. Scroll down to find the application form (usually below job description)
3. Read the visible form structure and fill text fields
4. **Radio buttons**: If a custom overlay blocks a control, follow the [browser fallback rules](browser.md) or leave it for the user
5. **Resume upload**: Use the visible resume file control and verify the filename
6. Review all fields, stop before the final action, and let the user submit manually
