import { useImageLoader } from '../../hooks/useImageLoader';
import type { ImageCacheEntry } from '../../utils/ImageLRUCache';

interface Props {
  cachedEditStateRef: React.RefObject<ImageCacheEntry | null>;
  handleImageLoadFailure: () => void;
}

export default function ImageLoaderManager({ cachedEditStateRef, handleImageLoadFailure }: Props) {
  useImageLoader(cachedEditStateRef, handleImageLoadFailure);

  return null;
}
