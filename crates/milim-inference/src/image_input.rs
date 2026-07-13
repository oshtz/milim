use base64::Engine;
use milim_core::api::openai::{Content, ContentPart};
use milim_core::{Error, Result};

use crate::CompletionRequest;

const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;

pub(crate) fn validate_request_images(req: &CompletionRequest) -> Result<()> {
    for message in &req.messages {
        let Some(Content::Parts(parts)) = &message.content else {
            continue;
        };
        for part in parts {
            let ContentPart::ImageUrl { image_url } = part else {
                continue;
            };
            validate_image_url(&image_url.url)?;
        }
    }
    Ok(())
}

fn validate_image_url(url: &str) -> Result<()> {
    if url.starts_with("http://") || url.starts_with("https://") {
        return Ok(());
    }
    let rest = url.strip_prefix("data:").ok_or_else(|| {
        Error::InvalidRequest(
            "image inputs must use inline data or an http:// or https:// URL".to_string(),
        )
    })?;
    let (media_type, data) = rest.split_once(";base64,").ok_or_else(|| {
        Error::InvalidRequest("image input is not a valid base64 data URL".to_string())
    })?;
    if !matches!(
        media_type,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) {
        return Err(Error::InvalidRequest(
            "image inputs must be PNG, JPEG, WebP, or GIF".to_string(),
        ));
    }
    if data.len() > MAX_IMAGE_BYTES * 4 / 3 + 8 {
        return Err(Error::InvalidRequest(
            "image inputs must be no larger than 2 MB".to_string(),
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| Error::InvalidRequest("image input is not valid base64".to_string()))?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(Error::InvalidRequest(
            "image inputs must contain 1 byte to 2 MB of data".to_string(),
        ));
    }
    let signature_matches = match media_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if !signature_matches {
        return Err(Error::InvalidRequest(format!(
            "image bytes do not match {media_type}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_real_image_data_and_rejects_mismatched_bytes() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC";
        assert!(validate_image_url(&format!("data:image/png;base64,{png}")).is_ok());
        assert!(validate_image_url("data:image/png;base64,AAAA").is_err());
        assert!(validate_image_url("data:image/svg+xml;base64,AAAA").is_err());
    }
}
