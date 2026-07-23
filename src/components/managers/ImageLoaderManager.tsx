import { useImageLoader } from '../../hooks/useImageLoader';

interface Props {
  cachedEditStateRef: React.RefObject<any>;
  handleImageLoadFailure: () => void;
}

export default function ImageLoaderManager({ cachedEditStateRef, handleImageLoadFailure }: Props) {
  useImageLoader(cachedEditStateRef, handleImageLoadFailure);

  return null;
}
