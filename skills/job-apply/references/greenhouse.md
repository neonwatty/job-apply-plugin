### Greenhouse

**Characteristics:**
- Single long-form page with sections
- Clear field labels
- Often has "Add another" for work history/education
- May be embedded in an iframe on a company career site

**Approach (visible browser first):**
1. Navigate to the application URL in the host-managed visible browser
2. Read the visible form; if an embedded form is inaccessible, follow the [browser fallback rules](browser.md) or leave it for the user
3. Fill from top to bottom
4. **Phone country code**: Select the country code supported by the confirmed applicant phone number and country; never assume United States or +1. Ask if those facts conflict.
5. For work history sections:
   - Fill most recent position
   - Click "Add another" if form allows and user has more history
6. Education section similar pattern
7. Handle custom questions at bottom
8. Upload the resume through the visible file control and confirm the filename
9. Stop before the final "Submit Application" button, give a value-free field-name/status summary, and hand control to the user

**Field patterns:**
- Standard `<input>` and `<select>` elements
- `#first_name`, `#last_name`, `#email`, `#phone` common IDs
- `.field-container` or `.field` wrapping each question
