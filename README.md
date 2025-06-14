# MailDeck - A Simple AWS SES Email Client

MailDeck is a lightweight, single-page web application that serves as a user interface for sending and receiving emails via Amazon Web Services (AWS). It uses AWS SES for email operations and S3 for storing email content. The entire application is designed to be hosted for free on Vercel.

## Features

- **Inbox, Sent & Trash Folders**: View emails received, sent, and moved to trash.
- **Email Viewing**: View formatted HTML emails in a clean modal interface.
- **Compose & Send**: A rich-text editor (Quill.js) for composing and sending new emails.
- **Attachments**: Supports sending and downloading file attachments.
- **Dynamic Sender List**: Can dynamically fetch all verified sender identities from AWS SES.
- **Secure**: Uses environment variables for all sensitive credentials and an auth token for API requests.
- **Responsive UI**: A clean, responsive interface built with Tailwind CSS.

## Tech Stack

- **Backend**:
  - **Runtime**: Node.js
  - **Framework**: Express.js
  - **Services**: AWS SDK for JavaScript (v3) for SES and S3.
- **Frontend**:
  - **Language**: Vanilla JavaScript (ES6+)
  - **Styling**: Tailwind CSS
  - **Editor**: Quill.js
- **Hosting**:
  - **Platform**: Vercel (for both frontend and backend serverless functions)

## Project Structure

The project is structured for a seamless Vercel deployment.
maildeck-project/
├── api/
│ └── index.js # The Express.js backend API (as a Serverless Function)
├── public/
│ └── index.html # The static frontend HTML, CSS, and JS
├── package.json # Backend dependencies for Node.js
├── vercel.json # Vercel routing configuration
└── README.md # This documentation file

---

## Deployment Guide

Follow these steps to deploy your own instance of MailDeck.

### Step 1: AWS Prerequisites

1.  **Create an IAM User**:

    - Go to the AWS IAM console and create a new user with "programmatic access".
    - Save the generated **Access Key ID** and **Secret Access Key**.
    - Attach the following IAM policy to this user, replacing `YOUR_S3_BUCKET_NAME` with your bucket's name.

    ```json
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Sid": "AllowSESActions",
          "Effect": "Allow",
          "Action": ["ses:SendRawEmail", "ses:ListEmailIdentities"],
          "Resource": "*"
        },
        {
          "Sid": "AllowS3BucketAccess",
          "Effect": "Allow",
          "Action": ["s3:ListBucket"],
          "Resource": "arn:aws:s3:::YOUR_S3_BUCKET_NAME"
        },
        {
          "Sid": "AllowS3ObjectAccess",
          "Effect": "Allow",
          "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          "Resource": "arn:aws:s3:::YOUR_S3_BUCKET_NAME/*"
        }
      ]
    }
    ```

2.  **Create an S3 Bucket**:

    - Go to the S3 console and create a new bucket (e.g., `my-maildeck-emails`). This bucket will store all your email files.
    - Create a folder named `sent` inside the bucket.

3.  **Verify Identities in SES**:
    - Go to the Amazon SES console.
    - **Note your AWS Region** (e.g., `us-east-1`, `us-west-2`). This is crucial.
    - Under "Verified identities", create and verify all the email addresses you wish to send mail from.

### Step 2: Vercel Deployment

1.  **Push to GitHub**: Push your project folder to a new GitHub repository.

2.  **Import to Vercel**:

    - Sign up for Vercel and import the GitHub repository.
    - When prompted for **Framework Preset**, choose **Other**.
    - Do not override any of the default "Build and Development Settings".

3.  **Configure Environment Variables**:
    - In your Vercel project dashboard, go to **Settings -> Environment Variables**.
    - Add the following secrets. Ensure they are available for the Production environment.

| Variable Name           | Example Value                              |
| ----------------------- | ------------------------------------------ |
| `AWS_ACCESS_KEY_ID`     | `AKIAIOSFODNN7EXAMPLE`                     |
| `AWS_SECRET_ACCESS_KEY` | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| `S3_BUCKET`             | `my-maildeck-emails`                       |
| `SES_REGION`            | `us-east-1` (or your correct SES region)   |
| `APP_USER`              | `admin`                                    |
| `APP_PASSWORD`          | `YourSecurePasswordHere`                   |
| `AUTH_TOKEN`            | `YourSecureRandomTokenHere`                |

4.  **Deploy**: Click the **Deploy** button. Vercel will build and deploy your application.

---

## Future Enhancements & Development

### Local Development

1.  **Install Vercel CLI**: `npm install -g vercel`
2.  **Install Dependencies**: `npm install`
3.  **Create Local Environment File**: Create a file named `.env.local` in the project root. **This file should not be committed to Git.**
    ```
    # .env.local
    AWS_ACCESS_KEY_ID=YourAccessKey
    AWS_SECRET_ACCESS_KEY=YourSecretKey
    S3_BUCKET=my-maildeck-emails
    SES_REGION=us-east-1
    APP_USER=admin
    APP_PASSWORD=YourPassword
    AUTH_TOKEN=YourToken
    ```
4.  **Run Development Server**: Run the command `vercel dev`. This will start a local server that perfectly mimics the Vercel production environment, including routing and environment variables.

### Re-enabling Dynamic Senders

The application is currently using a hardcoded list of senders in `api/index.js` as a temporary fix. To revert to the dynamic, production-ready version:

1.  **Ensure AWS Configuration is Correct**: Confirm that your `SES_REGION` environment variable in Vercel exactly matches the AWS region where your email identities are verified.

2.  **Update `api/index.js`**: Replace the temporary `getVerifiedSenders` function with the original dynamic version.

    ```javascript
    // In api/index.js
    async function getVerifiedSenders() {
      if (cachedSenders !== null) {
        return cachedSenders
      }
      try {
        const allIdentities = []
        let nextToken
        do {
          const command = new ListEmailIdentitiesCommand({
            NextToken: nextToken,
          })
          const response = await sesClient.send(command)
          allIdentities.push(...response.EmailIdentities)
          nextToken = response.NextToken
        } while (nextToken)

        const verifiedEmails = allIdentities
          .filter(
            (identity) =>
              identity.IdentityType === "EMAIL_ADDRESS" &&
              identity.VerifiedForSendingStatus === true
          )
          .map((identity) => identity.IdentityName)

        cachedSenders = verifiedEmails
        return cachedSenders
      } catch (error) {
        console.error("CRITICAL ERROR fetching SES identities:", error)
        return []
      }
    }
    ```

3.  **Update `public/index.html`**: Restore the error-checking functionality in the `initializeApp` function.

    ```javascript
    // In public/index.html, inside the <script> tag
    async function initializeApp() {
      await loadAvailableSenders()

      if (availableSenders.length === 0) {
        emailListDiv.innerHTML = `<div class="m-4 p-4 rounded-md bg-red-100 text-red-700"><strong>Critical Error:</strong> Could not load sender accounts from AWS. Please check server logs and IAM permissions (ses:ListEmailIdentities).</div>`
        return
      }

      initializeQuill()
      loadReadStatus()
      loadEmails(currentView)
      renderAccountNav()
      renderSettingsMenu()
      addAppEventListeners()
    }
    ```

### Other Potential Enhancements

- **Backend Pagination**: Currently, the app only fetches the latest 100 emails. Implement backend pagination for better performance with large mailboxes.
- **Drafts Folder**: Save unsent emails as drafts.
- **Improved Search**: Implement a more robust search functionality on the backend instead of filtering on the client.
- **Email Threading**: Group emails into conversations based on subject and headers.
